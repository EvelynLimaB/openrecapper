import WebSocket from 'ws';
import { Config } from '../config';
import {
  ButtonInteraction,
  ColorResolvable,
  EmbedBuilder,
  TextChannel,
} from 'discord.js';
import { CampaignTermsService } from './campaign-terms-service';
import { CharacterModeService } from './character-mode-service';

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

  private textChannel: TextChannel;
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
    voiceChannelId: string,
    sessionToken: string,
  ) {
    this.textChannel = textChannel;
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

  /**
   * Open a Deepgram streaming WebSocket for a user and return
   * a writable callback to send PCM audio data.
   */
  async openStreamForUser(
    userId: string,
  ): Promise<(pcmChunk: Buffer) => void> {
    // Reuse an already-open stream for this user.
    const existing = this.connections.get(userId);

    if (existing && existing.readyState === WebSocket.OPEN) {
      console.log(
        `[LiveTranscription] Reusing existing Deepgram stream for user ${userId}`,
      );

      this.lastAudioAt.set(userId, Date.now());
      this.startKeepAliveTimer(userId, existing);

      return (pcmChunk: Buffer) => {
        if (this.closed) {
          return;
        }

        if (existing.readyState === WebSocket.OPEN) {
          try {
            existing.send(pcmChunk);
            this.lastAudioAt.set(userId, Date.now());
          } catch (err) {
            console.error(
              `[LiveTranscription] Failed to send PCM for user ${userId}:`,
              err,
            );
          }
        }
      };
    }

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

    console.log(
      `[LiveTranscription] Deepgram stream opened for ${username}`,
    );

    this.connections.set(userId, ws);
    this.lastAudioAt.set(userId, Date.now());
    this.startFlushTimer();
    this.startKeepAliveTimer(userId, ws);

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
    });

    return (pcmChunk: Buffer) => {
      if (this.closed) {
        return;
      }

      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(pcmChunk);

          // Track when audio was last sent. Do NOT recreate the
          // KeepAlive timer for every PCM packet.
          this.lastAudioAt.set(userId, Date.now());
        } catch (err) {
          console.error(
            `[LiveTranscription] Failed to send PCM for ${username}:`,
            err,
          );
        }
      }
    };
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
    // Group consecutive results by speaker.
    const lines: string[] = [];
    let lastUser = '';

    for (const item of items) {
      if (item.username !== lastUser) {
        lines.push(`**${item.username}:** ${item.text}`);
        lastUser = item.username;
      } else {
        lines[lines.length - 1] += ` ${item.text}`;
      }
    }

    // Split into Discord-safe messages.
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
      let splitAt =
        remaining.lastIndexOf(
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
          group.label.length +
          chunk.length;

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
          .setColor(
            group.color as ColorResolvable,
          );

        embeds.push(embed);
        totalLength += estimatedLength;
      }
    }

    await sendEmbeds();
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
   * Post the DM/character mode control panel to the transcript channel.
   */
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
      await this.textChannel.send({
        content: CharacterModeService.buildPanelContent(
          this.textChannel.guild.id,
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

  /**
   * Handle a DM/character mode button interaction.
   *
   * Only configured DM users can change the mode.
   * Buttons from old recording sessions are rejected.
   */
  async handleCharacterModeButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    if (!CharacterModeService.isDmUser(interaction.user.id)) {
      await interaction.reply({
        content:
          'Apenas a DM configurada pode alterar o modo de fala.',
        ephemeral: true,
      });
      return;
    }

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
        ephemeral: true,
      });
      return;
    }

    const parsed =
      CharacterModeService.modeFromButton(
        interaction.customId,
      );

    if (!parsed) {
      await interaction.reply({
        content: 'Modo de fala invalido.',
        ephemeral: true,
      });
      return;
    }

    if (
      parsed.mode === 'character' &&
      !parsed.characterName
    ) {
      await interaction.reply({
        content: 'Personagem invalido.',
        ephemeral: true,
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
        content: 'Esse personagem nao esta configurado.',
        ephemeral: true,
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

  /**
   * Close a single user's Deepgram WebSocket.
   */
  closeStreamForUser(userId: string): void {
    this.clearKeepAliveTimer(userId);
    this.lastAudioAt.delete(userId);

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