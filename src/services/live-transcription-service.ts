import WebSocket from 'ws';
import { Config } from '../config';
import {
  ButtonInteraction,
  ColorResolvable,
  EmbedBuilder,
  StringSelectMenuInteraction,
  TextChannel,
  MessageFlags,
} from 'discord.js';
import {
  CharacterModeService,
  SpeakerPresentation,
} from './character-mode-service';
import { CampaignTermsService } from './campaign-terms-service';

interface PendingTranscript {
  userId: string;
  username: string;
  label: string;
  color: string;
  text: string;
  timestamp: number;
}

interface DeepgramConnectionError extends Error {
  statusCode?: number;
  responseBody?: string;
}

/**
 * Manages real-time transcription for a recording session.
 *
 * Opens one Deepgram WebSocket per speaker, sends raw PCM audio,
 * buffers finalized transcript results, and posts them to Discord.
 */
export class LiveTranscriptionService {
  private connections: Map<string, WebSocket> = new Map();
  private keepAliveTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastAudioAt: Map<string, number> = new Map();
  private userNames: Map<string, string> = new Map();

  // Live captions are posted to #legendas.
  private textChannel: TextChannel;
  // Character controls and the final transcript live in #transcrição.
  private transcriptChannel: TextChannel;
  private voiceChannelId: string;
  private sessionToken: string;
  private buffer: PendingTranscript[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  // Buffer transcripts for this many ms before posting.
  private static FLUSH_INTERVAL_MS = 3000;

  // Keep Discord messages below the API limit.
  private static MAX_MESSAGE_LENGTH = 1900;

  // Discord embed description maximum is 4096.
  private static MAX_EMBED_DESCRIPTION_LENGTH = 3900;

  // Keep total embed content safely below Discord's message limit.
  private static MAX_EMBED_MESSAGE_LENGTH = 5800;

  // Deepgram recommends KeepAlive every 3-5 seconds during silence.
  private static KEEPALIVE_INTERVAL_MS = 4000;

  constructor(
    textChannel: TextChannel,
    transcriptChannel: TextChannel,
    voiceChannelId: string,
    sessionToken: string,
  ) {
    this.textChannel = textChannel;
    this.transcriptChannel = transcriptChannel;
    this.voiceChannelId = voiceChannelId;
    this.sessionToken = sessionToken;
  }

  /**
   * Resolve a Discord user ID to a display name.
   */
  async resolveUsername(userId: string): Promise<string> {
    if (this.userNames.has(userId)) {
      return this.userNames.get(userId)!;
    }

    try {
      const { getClient } = require('../client');
      getClient();

      const guild = this.textChannel.guild;
      const member = await guild.members.fetch(userId);

      const name = member.displayName || member.user.username;

      this.userNames.set(userId, name);
      return name;
    } catch {
      const fallback = `User ${userId.slice(-4)}`;
      this.userNames.set(userId, fallback);
      return fallback;
    }
  }

  /**
   * Build the Deepgram streaming query parameters.
   */
  private buildDeepgramParams(
    includeKeyterms: boolean,
  ): URLSearchParams {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'multi',
      encoding: 'linear16',
      sample_rate: '48000',
      channels: '2',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'false',
      endpointing: '100',
    });

    if (includeKeyterms) {
      const campaignTerms = CampaignTermsService.load();
      CampaignTermsService.applyToParams(params, campaignTerms);
    }

    return params;
  }

  /**
   * Open the Deepgram WebSocket and return it only after
   * a successful HTTP 101 WebSocket handshake.
   *
   * HTTP handshake failures are surfaced immediately, including
   * the actual status code instead of becoming a generic timeout.
   */
  private connectToDeepgram(
    params: URLSearchParams,
    username: string,
  ): Promise<WebSocket> {
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${Config.DEEPGRAM_API_KEY}`,
      },
    });

    return new Promise((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        const error = new Error(
          `[LiveTranscription] Deepgram WS timeout for ${username}`,
        ) as DeepgramConnectionError;

        fail(error);
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('open', onOpen);
        ws.off('error', onErrorBeforeOpen);
        ws.off('close', onCloseBeforeOpen);
        ws.off('unexpected-response', onUnexpectedResponse);
      };

      const fail = (error: DeepgramConnectionError) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        try {
          if (
            ws.readyState === WebSocket.OPEN ||
            ws.readyState === WebSocket.CONNECTING
          ) {
            ws.close();
          }
        } catch {}

        reject(error);
      };

      const onOpen = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(ws);
      };

      const onErrorBeforeOpen = (err: Error) => {
        const error = new Error(
          `[LiveTranscription] Deepgram WS error for ${username}: ${err.message}`,
        ) as DeepgramConnectionError;

        fail(error);
      };

      const onCloseBeforeOpen = (
        code: number,
        reason: Buffer,
      ) => {
        const reasonText = reason?.toString() || '';

        const error = new Error(
          `[LiveTranscription] Deepgram WS closed before opening for ${username}: ${code}${reasonText ? ` ${reasonText}` : ''}`,
        ) as DeepgramConnectionError;

        fail(error);
      };

      const onUnexpectedResponse = (
        _request: unknown,
        response: {
          statusCode?: number;
          statusMessage?: string;
          on: (
            event: string,
            listener: (...args: unknown[]) => void,
          ) => void;
          resume?: () => void;
        },
      ) => {
        const statusCode = response.statusCode ?? 0;
        const statusMessage = response.statusMessage
          ? ` ${response.statusMessage}`
          : '';

        const error = new Error(
          `[LiveTranscription] Deepgram HTTP handshake failed for ${username}: ${statusCode}${statusMessage}`,
        ) as DeepgramConnectionError;

        error.statusCode = statusCode;

        let body = '';

        try {
          response.on('data', (...args: unknown[]) => {
            const chunk = args[0];
            if (Buffer.isBuffer(chunk)) {
              body += chunk.toString('utf8');
            } else if (typeof chunk === 'string') {
              body += chunk;
            }
          });

          response.on('end', () => {
            if (body.trim()) {
              error.responseBody = body.trim();

              console.error(
                `[LiveTranscription] Deepgram handshake response for ${username}: ${body.trim()}`,
              );
            }

            fail(error);
          });

          response.on('error', (...args: unknown[]) => {
            const responseError = args[0];

            if (responseError instanceof Error) {
              error.responseBody = responseError.message;
            }

            fail(error);
          });
        } catch {
          fail(error);
        }

        try {
          response.resume?.();
        } catch {}
      };

      ws.once('open', onOpen);
      ws.once('error', onErrorBeforeOpen);
      ws.once('close', onCloseBeforeOpen);
      ws.once('unexpected-response', onUnexpectedResponse);
    });
  }

  // A user can keep recording to Discord even when Deepgram closes its
  // websocket unexpectedly (for example NET-0000). Keep the sender stable and
  // reconnect the Deepgram side on the next audio packet instead of requiring
  // VoiceWorker to create a new Discord subscription.
  private connecting: Map<string, Promise<WebSocket>> = new Map();
  private intentionallyClosedUsers: Set<string> = new Set();
  private pendingAudio: Map<string, Buffer[]> = new Map();
  private pendingAudioBytes: Map<string, number> = new Map();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private lastAudioProducedAt: Map<string, number> = new Map();

  // Bound in-memory queue for audio produced while a reconnect is in flight.
  // Final transcription always uses the PCM file, so this queue only protects
  // the live captions path from unbounded memory growth during a bad outage.
  private static MAX_PENDING_AUDIO_BYTES = 1024 * 1024;

  /**
   * Open a Deepgram streaming WebSocket for a user and return a stable sender.
   * If Deepgram later closes the websocket unexpectedly, the sender will queue
   * the next audio and transparently establish a replacement stream.
   */
  async openStreamForUser(
    userId: string,
  ): Promise<(pcmChunk: Buffer) => void> {
    this.intentionallyClosedUsers.delete(userId);
    await this.ensureDeepgramStream(userId);

    return (pcmChunk: Buffer) => {
      if (this.closed || pcmChunk.length === 0) {
        return;
      }

      this.lastAudioProducedAt.set(userId, Date.now());

      const ws = this.connections.get(userId);

      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(pcmChunk);
          this.lastAudioAt.set(userId, Date.now());
          return;
        } catch (err) {
          console.error(
            `[LiveTranscription] Failed to send PCM for user ${userId}:`,
            err,
          );
        }
      }

      this.queuePendingAudio(userId, pcmChunk);

      void this.ensureDeepgramStream(userId)
        .then(() => this.flushPendingAudio(userId))
        .catch((err) => {
          console.error(
            `[LiveTranscription] Failed to reconnect live stream for user ${userId}:`,
            err,
          );
        });
    };
  }

  private async ensureDeepgramStream(userId: string): Promise<WebSocket> {
    if (this.closed || this.intentionallyClosedUsers.has(userId)) {
      throw new Error(
        `[LiveTranscription] Live stream for ${userId} is closing`,
      );
    }

    const existing = this.connections.get(userId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      return existing;
    }

    const inFlight = this.connecting.get(userId);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.createDeepgramStream(userId);
    this.connecting.set(userId, promise);

    try {
      return await promise;
    } finally {
      if (this.connecting.get(userId) === promise) {
        this.connecting.delete(userId);
      }
    }
  }

  private async createDeepgramStream(userId: string): Promise<WebSocket> {
    const username = await this.resolveUsername(userId);

    let ws: WebSocket;
    const paramsWithKeyterms = this.buildDeepgramParams(true);

    try {
      ws = await this.connectToDeepgram(
        paramsWithKeyterms,
        username,
      );
    } catch (err) {
      const error = err as DeepgramConnectionError;

      /*
       * The campaign keyterm estimator used by this project is
       * conservative, but Deepgram validates the actual token count
       * server-side. If the request is rejected with HTTP 400 while
       * keyterms are enabled, retry once without keyterms.
       */
      if (error.statusCode === 400) {
        console.warn(
          `[LiveTranscription] Deepgram rejected the keyterm configuration for ${username}; retrying without keyterms.`,
        );

        if (error.responseBody) {
          console.warn(
            `[LiveTranscription] Deepgram response: ${error.responseBody}`,
          );
        }

        const fallbackParams = this.buildDeepgramParams(false);
        ws = await this.connectToDeepgram(
          fallbackParams,
          `${username} (without keyterms)`,
        );

        console.log(
          `[LiveTranscription] Deepgram stream opened for ${username} without keyterms`,
        );
      } else {
        throw error;
      }
    }

    if (this.closed || this.intentionallyClosedUsers.has(userId)) {
      try {
        ws.close();
      } catch {}
      throw new Error(
        `[LiveTranscription] Live stream for ${userId} closed during connection`,
      );
    }

    const previous = this.connections.get(userId);
    if (previous && previous !== ws) {
      try {
        if (previous.readyState === WebSocket.OPEN) {
          previous.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch {}
      try {
        previous.close();
      } catch {}
    }

    this.connections.set(userId, ws);
    this.lastAudioAt.set(userId, Date.now());
    this.reconnectAttempts.delete(userId);
    const reconnectTimer = this.reconnectTimers.get(userId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.reconnectTimers.delete(userId);
    }
    this.startFlushTimer();
    this.startKeepAliveTimer(userId, ws);
    this.flushPendingAudio(userId);

    console.log(
      `[LiveTranscription] Deepgram stream opened for ${username}`,
    );

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (
          msg.type === 'Results' &&
          msg.is_final &&
          msg.channel?.alternatives?.[0]
        ) {
          const transcript =
            msg.channel.alternatives[0].transcript?.trim();

          if (transcript) {
            const presentation =
              CharacterModeService.getPresentation(
                this.textChannel.guild.id,
                this.voiceChannelId,
                userId,
                username,
              );

            this.buffer.push({
              userId,
              username,
              label: presentation.label,
              color: presentation.color,
              text: transcript,
              timestamp: Date.now(),
            });
          }
        }
      } catch (err) {
        console.error(
          '[LiveTranscription] Error parsing Deepgram message:',
          err,
        );
      }
    });

    ws.on('error', (err) => {
      console.error(
        `[LiveTranscription] Deepgram WS error for ${username}:`,
        err.message,
      );
    });

    ws.on('close', (code, reason) => {
      const reasonText = reason?.toString() || '';

      console.log(
        `[LiveTranscription] Deepgram stream closed for ${username}: ${code}${reasonText ? ` ${reasonText}` : ''}`,
      );

      const current = this.connections.get(userId);

      if (current === ws) {
        this.connections.delete(userId);
      }

      this.clearKeepAliveTimer(userId);
      this.lastAudioAt.delete(userId);

      if (
        !this.closed &&
        !this.intentionallyClosedUsers.has(userId)
      ) {
        const normalizedReason = reasonText.toLowerCase();
        const isNoAudioTimeout =
          normalizedReason.includes('no_audio_timeout');

        const lastProduced = this.lastAudioProducedAt.get(userId) ?? 0;
        const recentlyProducedAudio =
          lastProduced > 0 &&
          Date.now() - lastProduced <= 15000;
        const hasPendingAudio =
          (this.pendingAudioBytes.get(userId) ?? 0) > 0;

        // Deepgram documents 1011/NET-0000 as a transient streaming failure
        // that should be recovered by creating a new WebSocket. Abnormal 1006
        // closes are also retried when this user was recently producing audio.
        // NET-0002/no_audio_timeout is intentionally left demand-driven: the
        // next PCM packet will reopen the stream without holding an idle socket.
        const shouldReconnect =
          !isNoAudioTimeout &&
          (code === 1011 || code === 1006) &&
          (recentlyProducedAudio || hasPendingAudio);

        if (shouldReconnect) {
          console.warn(
            `[LiveTranscription] Scheduling Deepgram reconnect for ${username} after unexpected close.`,
          );
          this.scheduleReconnect(userId, username);
        } else {
          console.warn(
            `[LiveTranscription] Deepgram stream for ${username} ended unexpectedly; live transcription will reconnect when audio is produced again.`,
          );
        }
      }
    });

    return ws;
  }

  private scheduleReconnect(userId: string, username: string): void {
    if (
      this.closed ||
      this.intentionallyClosedUsers.has(userId) ||
      this.reconnectTimers.has(userId)
    ) {
      return;
    }

    const attempt = this.reconnectAttempts.get(userId) ?? 0;
    const delayMs = Math.min(
      1000 * (2 ** attempt),
      15000,
    );

    this.reconnectAttempts.set(userId, attempt + 1);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(userId);

      if (
        this.closed ||
        this.intentionallyClosedUsers.has(userId)
      ) {
        return;
      }

      void this.ensureDeepgramStream(userId)
        .then(() => {
          this.flushPendingAudio(userId);
        })
        .catch((err) => {
          console.error(
            `[LiveTranscription] Deepgram reconnect failed for ${username}; retrying:`,
            err,
          );
          this.scheduleReconnect(userId, username);
        });
    }, delayMs);

    this.reconnectTimers.set(userId, timer);

    console.log(
      `[LiveTranscription] Deepgram reconnect for ${username} scheduled in ${delayMs}ms (attempt ${attempt + 1}).`,
    );
  }

  private queuePendingAudio(userId: string, chunk: Buffer): void {
    const queue = this.pendingAudio.get(userId) ?? [];
    const previousBytes = this.pendingAudioBytes.get(userId) ?? 0;

    queue.push(chunk);
    let nextBytes = previousBytes + chunk.length;

    while (
      nextBytes > LiveTranscriptionService.MAX_PENDING_AUDIO_BYTES &&
      queue.length > 0
    ) {
      const removed = queue.shift()!;
      nextBytes -= removed.length;
    }

    this.pendingAudio.set(userId, queue);
    this.pendingAudioBytes.set(userId, nextBytes);
  }

  private flushPendingAudio(userId: string): void {
    const ws = this.connections.get(userId);
    const queue = this.pendingAudio.get(userId);

    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      !queue ||
      queue.length === 0
    ) {
      return;
    }

    this.pendingAudio.delete(userId);
    this.pendingAudioBytes.delete(userId);

    for (let i = 0; i < queue.length; i++) {
      const chunk = queue[i];

      try {
        ws.send(chunk);
        this.lastAudioAt.set(userId, Date.now());
      } catch (err) {
        for (let j = i; j < queue.length; j++) {
          this.queuePendingAudio(userId, queue[j]);
        }

        console.error(
          `[LiveTranscription] Failed flushing queued PCM for user ${userId}:`,
          err,
        );
        break;
      }
    }
  }
  // --- Deepgram KeepAlive management ---

  /**
   * Keep exactly one timer per user.
   *
   * KeepAlive is only sent when the user has been silent long enough.
   * Continuous PCM audio does not need extra KeepAlive messages.
   */
  private startKeepAliveTimer(
    userId: string,
    ws: WebSocket,
  ): void {
    this.clearKeepAliveTimer(userId);

    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.clearKeepAliveTimer(userId);
        return;
      }

      const lastAudio = this.lastAudioAt.get(userId) ?? 0;
      const silenceMs = Date.now() - lastAudio;

      if (silenceMs < LiveTranscriptionService.KEEPALIVE_INTERVAL_MS) {
        return;
      }

      try {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      } catch (err) {
        console.error(
          `[LiveTranscription] Failed to send KeepAlive for user ${userId}:`,
          err,
        );
        this.clearKeepAliveTimer(userId);
      }
    }, LiveTranscriptionService.KEEPALIVE_INTERVAL_MS);

    this.keepAliveTimers.set(userId, timer);
  }

  private clearKeepAliveTimer(userId: string): void {
    const timer = this.keepAliveTimers.get(userId);

    if (timer) {
      clearInterval(timer);
      this.keepAliveTimers.delete(userId);
    }
  }

  // --- Discord transcript buffering ---

  private startFlushTimer(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error(
          '[LiveTranscription] Flush error:',
          err,
        );
      });
    }, LiveTranscriptionService.FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const items = this.buffer.splice(0);

    if (!CharacterModeService.isEnabled()) {
      await this.flushPlainText(items);
      return;
    }

    await this.flushEmbeds(items);
  }

  private async flushPlainText(
    items: PendingTranscript[],
  ): Promise<void> {
    const lines: string[] = [];
    let lastUser = '';

    for (const item of items) {
      if (item.username !== lastUser) {
        lines.push(`**${item.username}:** ${item.text}`);
        lastUser = item.username;
      } else if (lines.length > 0) {
        lines[lines.length - 1] += ` ${item.text}`;
      }
    }

    let message = '';

    for (const line of lines) {
      if (
        message.length + line.length + 1 >
        LiveTranscriptionService.MAX_MESSAGE_LENGTH
      ) {
        if (message) {
          await this.postToChannel(message);
          message = '';
        }
      }

      message += (message ? '\n' : '') + line;
    }

    if (message) {
      await this.postToChannel(message);
    }
  }

  private splitTranscriptText(text: string): string[] {
    if (
      text.length <=
      LiveTranscriptionService.MAX_EMBED_DESCRIPTION_LENGTH
    ) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (
      remaining.length >
      LiveTranscriptionService.MAX_EMBED_DESCRIPTION_LENGTH
    ) {
      let splitAt = remaining.lastIndexOf(
        ' ',
        LiveTranscriptionService.MAX_EMBED_DESCRIPTION_LENGTH,
      );

      if (splitAt <= 0) {
        splitAt =
          LiveTranscriptionService.MAX_EMBED_DESCRIPTION_LENGTH;
      }

      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    if (remaining) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private async flushEmbeds(
    items: PendingTranscript[],
  ): Promise<void> {
    interface EmbedGroup {
      label: string;
      color: string;
      text: string;
    }

    const groups: EmbedGroup[] = [];

    for (const item of items) {
      const last = groups[groups.length - 1];

      if (
        last &&
        last.label === item.label &&
        last.color === item.color
      ) {
        last.text += ` ${item.text}`;
      } else {
        groups.push({
          label: item.label,
          color: item.color,
          text: item.text,
        });
      }
    }

    let embeds: EmbedBuilder[] = [];
    let totalLength = 0;

    const sendEmbeds = async (): Promise<void> => {
      if (embeds.length === 0) {
        return;
      }

      try {
        await this.textChannel.send({
          embeds,
        });
      } catch (err) {
        console.error(
          '[LiveTranscription] Failed to post embeds to channel:',
          err,
        );
      }

      embeds = [];
      totalLength = 0;
    };

    for (const group of groups) {
      const chunks = this.splitTranscriptText(group.text);

      for (const chunk of chunks) {
        const estimatedLength =
          group.label.length + chunk.length;

        if (
          embeds.length >= 10 ||
          totalLength + estimatedLength >
            LiveTranscriptionService.MAX_EMBED_MESSAGE_LENGTH
        ) {
          await sendEmbeds();
        }

        const embed = new EmbedBuilder()
          .setAuthor({ name: group.label })
          .setDescription(chunk)
          .setColor(group.color as ColorResolvable);

        embeds.push(embed);
        totalLength += estimatedLength;
      }
    }

    await sendEmbeds();
  }

  getPresentationSnapshot(): Map<string, SpeakerPresentation> {
    return CharacterModeService.buildPresentationMap(
      this.textChannel.guild.id,
      this.voiceChannelId,
      this.userNames,
    );
  }

  async postCharacterModePanel(): Promise<void> {
    if (!CharacterModeService.isEnabled()) {
      return;
    }

    const dmUserIds = CharacterModeService.getDmUserIds();

    if (dmUserIds.length === 0) {
      return;
    }

    const userId = dmUserIds[0];

    try {
      await this.transcriptChannel.send({
        content: CharacterModeService.buildPanelContent(
          this.transcriptChannel.guild.id,
          this.voiceChannelId,
          userId,
        ),
        components:
          CharacterModeService.buildPanelComponents(
            this.voiceChannelId,
            this.sessionToken,
          ),
      });
    } catch (err) {
      console.error(
        '[LiveTranscription] Failed to post character mode panel:',
        err,
      );
    }
  }

  async handleCharacterModeButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const buttonVoiceChannelId =
      CharacterModeService.voiceChannelIdFromButton(
        interaction.customId,
      );

    const buttonSessionToken =
      CharacterModeService.sessionTokenFromButton(
        interaction.customId,
      );

    if (
      buttonVoiceChannelId !== this.voiceChannelId ||
      buttonSessionToken !== this.sessionToken
    ) {
      await interaction.reply({
        content:
          'Este painel pertence a uma gravação anterior.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      CharacterModeService.isChooseCharacterButton(
        interaction.customId,
      )
    ) {
      if (CharacterModeService.isDmUser(interaction.user.id)) {
        await interaction.reply({
          content:
            'A DM deve usar os controles de modo da própria DM.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content:
          'Selecione seu personagem para esta sessão.',
        components:
          CharacterModeService.buildPlayerSelectionComponents(
            interaction.guildId ?? this.textChannel.guild.id,
            this.voiceChannelId,
            this.sessionToken,
            interaction.user.id,
          ),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!CharacterModeService.isDmUser(interaction.user.id)) {
      await interaction.reply({
        content:
          'Apenas a DM configurada pode alterar o modo de fala.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const parsed = CharacterModeService.modeFromButton(
      interaction.customId,
    );

    if (!parsed) {
      await interaction.reply({
        content: 'Modo de fala inválido.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      parsed.mode === 'character' &&
      !parsed.characterName
    ) {
      await interaction.reply({
        content: 'Personagem inválido.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      parsed.mode === 'character' &&
      !CharacterModeService.getCharacter(
        parsed.characterName!,
      )
    ) {
      await interaction.reply({
        content: 'Esse personagem não está configurado.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      parsed.mode === 'npc' &&
      !CharacterModeService.getCharacter('NPC')
    ) {
      await interaction.reply({
        content: 'NPC não está configurado.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    CharacterModeService.setMode(
      interaction.guildId ?? this.textChannel.guild.id,
      this.voiceChannelId,
      interaction.user.id,
      parsed.mode,
      parsed.characterName,
    );

    await interaction.update({
      content: CharacterModeService.buildPanelContent(
        interaction.guildId ?? this.textChannel.guild.id,
        this.voiceChannelId,
        interaction.user.id,
      ),
      components:
        CharacterModeService.buildPanelComponents(
          this.voiceChannelId,
          this.sessionToken,
        ),
    });
  }

  async handleCharacterModeSelect(
    interaction: StringSelectMenuInteraction,
  ): Promise<void> {
    const selectVoiceChannelId =
      CharacterModeService.voiceChannelIdFromButton(
        interaction.customId,
      );

    const selectSessionToken =
      CharacterModeService.sessionTokenFromButton(
        interaction.customId,
      );

    if (
      selectVoiceChannelId !== this.voiceChannelId ||
      selectSessionToken !== this.sessionToken
    ) {
      await interaction.reply({
        content:
          'Este painel pertence a uma gravação anterior.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (CharacterModeService.isDmUser(interaction.user.id)) {
      await interaction.reply({
        content:
          'A DM deve usar os controles de modo da própria DM.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rawValue = interaction.values[0];

    if (!rawValue) {
      await interaction.reply({
        content: 'Nenhum personagem foi selecionado.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let selectedName: string | null = null;

    if (rawValue !== 'none') {
      try {
        selectedName = decodeURIComponent(rawValue);
      } catch {
        await interaction.reply({
          content: 'Seleção de personagem inválida.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const result =
      CharacterModeService.assignPlayerCharacter(
        interaction.guildId ?? this.textChannel.guild.id,
        this.voiceChannelId,
        interaction.user.id,
        selectedName,
      );

    if (!result.ok) {
      if (result.reason === 'reserved') {
        await interaction.reply({
          content:
            `O personagem **${result.character?.name ?? selectedName}** já está sendo usado por outro jogador nesta sessão.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content:
          'Esse personagem não pode ser selecionado por jogadores.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (result.character) {
      await interaction.reply({
        content:
          `Seu personagem nesta sessão agora é **${result.character.name}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content:
        'Seu personagem foi removido. A transcrição voltará a usar seu nome do Discord.',
      flags: MessageFlags.Ephemeral,
    });
  }

  private async postToChannel(
    content: string,
  ): Promise<void> {
    try {
      await this.textChannel.send(content);
    } catch (err) {
      console.error(
        '[LiveTranscription] Failed to post to channel:',
        err,
      );
    }
  }

  /**
   * Close a single user's Deepgram WebSocket.
   */
  closeStreamForUser(userId: string): void {
    this.intentionallyClosedUsers.add(userId);
    this.clearKeepAliveTimer(userId);
    this.lastAudioAt.delete(userId);
    this.lastAudioProducedAt.delete(userId);

    const reconnectTimer = this.reconnectTimers.get(userId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.reconnectTimers.delete(userId);
    }

    this.reconnectAttempts.delete(userId);
    this.pendingAudio.delete(userId);
    this.pendingAudioBytes.delete(userId);

    const ws = this.connections.get(userId);

    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {}
    }

    this.connections.delete(userId);
  }

  /**
   * Close all Deepgram WebSockets and flush remaining results.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Stop all KeepAlive timers.
    for (const userId of this.keepAliveTimers.keys()) {
      this.clearKeepAliveTimer(userId);
    }

    // Ask Deepgram to finalize and close every stream.
    for (const [userId, ws] of this.connections) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch {}
    }

    // Give Deepgram time to send final Results before the local
    // connection is forcefully closed.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Post any results that arrived during shutdown.
    await this.flush();

    // Force-close anything still open.
    for (const [userId, ws] of this.connections) {
      try {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      } catch {}

      this.lastAudioAt.delete(userId);
    }

    this.connections.clear();

    CharacterModeService.clearSession(
      this.textChannel.guild.id,
      this.voiceChannelId,
    );

    console.log('[LiveTranscription] All streams closed');
  }
}