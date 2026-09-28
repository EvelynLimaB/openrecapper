import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} from '@discordjs/voice';
import * as dgVoice from '@discordjs/voice';
import { createWriteStream, WriteStream } from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { Client } from 'discord.js';
import { OpusDecodingStream } from '../services/opus-decoder';
import { SilenceFiller } from '../services/silence-filler';
import { LiveTranscriptionService } from '../services/live-transcription-service';

export interface VoiceWorkerOptions {
  guildId: string;
  channelId: string;
  outputDir: string;
  // The identity that opens the voice connection (a recorder-pool lease's
  // client). Text/REST work stays on the primary client.
  client: Client;
  liveTranscription?: LiveTranscriptionService;
}

export interface StopResult {
  files: string[];
  userMap: Map<string, string>; // filePath -> userId
  userStartTimes: Map<string, number>; // filePath -> timestamp (ms) when user's audio first started
  sessionStartedAt: number; // timestamp (ms) when the VoiceWorker started
  sessionDir: string;
}

interface UserStream {
  filePath: string;
  writeStream: WriteStream;
  userId: string;
  startedAt: number; // Date.now() when this user's stream first started writing
}

export class VoiceWorker {
  private options: VoiceWorkerOptions;
  private connection: VoiceConnection | null = null;
  private userStreams: Map<string, UserStream> = new Map();
  private speaking: Set<string> = new Set();
  private sessionStartedAt: number = 0;
  // Track the first time each user started speaking (persists across stream reconnections)
  // Key: userId, Value: { filePath, startedAt }
  private userFirstStart: Map<string, { filePath: string; startedAt: number }> = new Map();
  // Track wall-clock ms when the last PCM chunk was written for each user.
  // Persists across opus-stream reconnections so a new SilenceFiller can fill
  // the gap between the old stream's end and the new stream's start.
  private userLastChunkTime: Map<string, number> = new Map();
  // Timestamp (ms) of the most recent opus packet received from ANY user.
  // Used by the silence-timeout feature to decide when to auto-leave.
  private lastVoiceActivityAt: number = 0;

  constructor(options: VoiceWorkerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.sessionStartedAt = Date.now();
    this.lastVoiceActivityAt = 0; // No activity until we receive actual audio
    const client = this.options.client;

    const guild = client.guilds.cache.get(this.options.guildId);
    if (!guild) throw new Error(`Guild ${this.options.guildId} not found`);

    this.connection = joinVoiceChannel({
      channelId: this.options.channelId,
      guildId: this.options.guildId,
      // @discordjs/voice keys connections by (group, guildId) and group
      // defaults to 'default'. With several clients in one process recording
      // the same guild, a shared group would make the second join clobber
      // the first connection — so each client gets its own group.
      group: client.user!.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      // daveEncryption defaults to true - required by Discord (4017 if disabled)
    });

    // Log connection state changes (only significant ones)
    this.connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(
          `[VoiceWorker] Connection: ${oldState.status} -> ${newState.status}`
        );
      }

      // Capture networking errors
      if ('networking' in newState) {
        const networking = (newState as any).networking;
        if (networking) {
          networking.on?.('close', (code: any) => {
            console.log(
              `[VoiceWorker] Networking WS close code: ${code}`
            );
          });

          networking.on?.('error', (err: any) => {
            console.error(`[VoiceWorker] Networking error:`, err);
          });
        }
      }
    });

    this.connection.on('error', (error) => {
      console.error(`[VoiceWorker] Connection error:`, error);
    });

    // Wait for connection to be ready
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      console.error(
        `[VoiceWorker] Failed to reach Ready state. Current status: ${this.connection.state.status}`
      );

      // Log full state for debugging
      console.error(
        `[VoiceWorker] Full state:`,
        JSON.stringify(
          this.connection.state,
          (key, val) => {
            if (key === 'ws' || key === 'networking') return '[object]';
            return val;
          },
          2
        )
      );

      this.connection.destroy();
      throw err;
    }

    console.log(
      `[VoiceWorker] Connected to channel ${this.options.channelId}`
    );

    // Listen for audio
    const receiver = this.connection.receiver;

    console.log(
      `[VoiceWorker] Receiver ready, listening for speaking events...`
    );

    receiver.speaking.on('start', (userId: string) => {
      // Never treat Discord bots as voice participants.
      // This must happen before updating lastVoiceActivityAt,
      // otherwise music/activity from a bot could prevent silence timeout.
      if (this.isBotUser(userId)) {
        console.log(`[VoiceWorker] Ignoring bot audio: ${userId}`);
        return;
      }

      // Mark voice activity only for real users.
      this.lastVoiceActivityAt = Date.now();

      if (this.userStreams.has(userId)) return; // Already recording this user
      this.startUserStream(userId, receiver);
    });

    // discord.js only emits a 'start' event when a user begins speaking AFTER
    // we subscribe. Anyone already talking when the bot joins (very common for
    // the person who issued /record from another channel while mid-sentence)
    // never triggers a fresh 'start' and would be silently dropped from both
    // the recording and the live transcript until they pause and resume.
    //
    // Proactively subscribe to every non-bot member already present in the
    // channel so their audio is captured from the moment they next speak,
    // independent of the speaking-start event. The live transcription stream
    // for each user is opened lazily on their first decoded PCM chunk (see
    // startUserStream), so silent listeners do not each hold open a Deepgram
    // websocket before they actually speak.
    //
    // Enumerate channel members via the PRIMARY client (its member cache is
    // warm from long-running gateway traffic; a freshly-logged-in recorder's
    // is not). The receiver we subscribe on still belongs to this worker's
    // recorder connection — enumeration and subscription are separable.
    const { getClient } = require('../client');
    this.subscribeExistingMembers(receiver, getClient());
  }

  private isBotUser(userId: string): boolean {
    const { getClient } = require('../client');
    const client = getClient();

    const guild = client.guilds.cache.get(this.options.guildId);
    const member = guild?.members.cache.get(userId);

    if (member?.user?.bot === true) {
      return true;
    }

    // Fallback to the global user cache.
    const user = client.users.cache.get(userId);
    return user?.bot === true;
  }

  private subscribeExistingMembers(receiver: any, client: any): void {
    try {
      const guild = client.guilds.cache.get(this.options.guildId);
      const channel = guild?.channels?.cache?.get(this.options.channelId);
      const members = channel?.members; // Collection<userId, GuildMember> for voice channels

      if (!members) return;

      for (const [userId, member] of members) {
        if (member.user?.bot) continue; // skip bots (including ourselves)
        if (this.userStreams.has(userId)) continue;

        console.log(
          `[VoiceWorker] Pre-subscribing to member already in channel: ${userId}`
        );

        this.startUserStream(userId, receiver);
      }
    } catch (err) {
      console.error(
        '[VoiceWorker] Failed to pre-subscribe existing members:',
        err
      );
    }
  }

  private startUserStream(userId: string, receiver: any): void {
    // Final safety guard: no bot should ever reach receiver.subscribe().
    // This protects every caller of startUserStream(), including both
    // speaking.start and pre-subscription.
    if (this.isBotUser(userId)) {
      console.log(`[VoiceWorker] Refusing to record bot: ${userId}`);
      return;
    }

    const filePath = path.join(this.options.outputDir, `${userId}.pcm`);

    // Append mode: if the opus stream auto-closes on silence and restarts,
    // we don't lose earlier audio
    const writeStream = createWriteStream(filePath, { flags: 'a' });

    // Use Manual end behavior — we control when the stream ends (at stop time)
    // This keeps a single long-lived subscription for the entire recording session
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });

    const decoder = new OpusDecodingStream();

    // SilenceFiller inserts zero-filled PCM to preserve real-time gaps.
    // Discord only delivers opus packets during active speech; without this,
    // the PCM file would concatenate speech segments with no silence between
    // them, destroying temporal alignment in the mixdown.
    //
    // If this user had a previous opus stream that auto-closed (silence timeout),
    // seed the SilenceFiller with the last chunk timestamp so the gap between
    // streams is properly filled with silence in the PCM file.
    const prevLastChunk = this.userLastChunkTime.get(userId) ?? 0;
    const silenceFiller = new SilenceFiller(prevLastChunk);

    // If live transcription is enabled, tee the decoded PCM to both file and Deepgram.
    // NOTE: Live transcription gets the raw decoded stream (without silence filling)
    // because Deepgram expects continuous speech, not padded silence.
    const live = this.options.liveTranscription;

    if (live) {
      let sendPcm: ((chunk: Buffer) => void) | null = null;
      let streamRequested = false;
      let earlyBufferBytes = 0;
      const earlyBuffer: Buffer[] = [];
      const MAX_EARLY_BUFFER_BYTES = 1024 * 1024;

      const requestLiveStream = (): void => {
        if (streamRequested || sendPcm) {
          return;
        }

        streamRequested = true;

        // Open Deepgram asynchronously, but never permanently latch a failed
        // initial connection. If the handshake fails, the next decoded PCM
        // packet is allowed to trigger another attempt.
        void live
          .openStreamForUser(userId)
          .then((send) => {
            sendPcm = send;

            for (const buf of earlyBuffer) {
              sendPcm(buf);
            }

            earlyBuffer.length = 0;
            earlyBufferBytes = 0;
          })
          .catch((err) => {
            streamRequested = false;

            console.error(
              `[VoiceWorker] Failed to open live stream for ${userId}; will retry on next audio packet:`,
              err
            );
          });
      };

      // Tee raw decoder output to live transcription (no silence filling).
      // The Deepgram stream is opened LAZILY on the first decoded PCM chunk —
      // not at subscribe time — so pre-subscribed but silent listeners do not
      // each consume a websocket/keepalive until they actually speak.
      decoder.on('data', (chunk: Buffer) => {
        if (sendPcm) {
          sendPcm(chunk);
          return;
        }

        earlyBuffer.push(chunk);
        earlyBufferBytes += chunk.length;

        while (
          earlyBufferBytes > MAX_EARLY_BUFFER_BYTES &&
          earlyBuffer.length > 0
        ) {
          const removed = earlyBuffer.shift()!;
          earlyBufferBytes -= removed.length;
        }

        requestLiveStream();
      });

      // Silence-filled stream goes to the file for correct mixdown
      silenceFiller.pipe(writeStream, { end: false });
      decoder.pipe(silenceFiller);
    } else {
      decoder.pipe(silenceFiller).pipe(writeStream, { end: false });
    }

    // Update last-activity timestamp on every opus packet so the silence
    // timeout resets continuously while anyone is speaking.
    //
    // We also record this user's first-start offset here (on the first real
    // audio packet) rather than at subscribe time. For lazily-subscribed users
    // these coincide, but for users we PRE-subscribe at join time (because they
    // were already mid-speech) the first packet may not arrive until much
    // later. The mixdown positions each user's file at userFirstStart.startedAt,
    // and the file content begins at the first packet, so the offset must be
    // anchored to the first packet to keep speakers time-aligned.
    opusStream.on('data', () => {
      this.lastVoiceActivityAt = Date.now();

      if (!this.userFirstStart.has(userId)) {
        const startedAt = Date.now();

        this.userFirstStart.set(userId, {
          filePath,
          startedAt,
        });

        console.log(
          `[VoiceWorker] First audio from user ${userId} at offset ${startedAt - this.sessionStartedAt}ms`
        );
      }
    });

    opusStream.pipe(decoder);

    // If the opus stream auto-closes (e.g. ~30s silence despite Manual mode),
    // clean up so the next speaking event can re-subscribe.
    //
    // Persist the SilenceFiller's last-chunk time so the next stream can fill
    // the gap between this stream's end and the next stream's start.
    opusStream.on('end', () => {
      const lastTime = silenceFiller.getLastChunkTime();

      if (lastTime > 0) {
        this.userLastChunkTime.set(userId, lastTime);
      }

      console.log(
        `[VoiceWorker] Opus stream ended for user ${userId} (will re-subscribe on next speech)`
      );

      this.userStreams.delete(userId);

      // Close the Deepgram WS for this user so it doesn't timeout
      if (this.options.liveTranscription) {
        this.options.liveTranscription.closeStreamForUser(userId);
      }
    });

    const now = Date.now();

    this.userStreams.set(userId, {
      filePath,
      writeStream,
      userId,
      startedAt: now,
    });

    // NOTE: userFirstStart is recorded on the first actual audio packet (see the
    // opusStream 'data' handler above), not here, so that pre-subscribed users
    // who are not yet speaking get an accurate start offset. Reconnections after
    // a silence timeout keep the original first-start (guarded by .has()).
    if (this.userFirstStart.has(userId)) {
      console.log(
        `[VoiceWorker] Resumed recording user ${userId} (stream reconnected after silence)`
      );
    }
  }

  async stop(): Promise<StopResult> {
    // Destroy voice connection
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    // Close all currently-open write streams
    for (const [, userStream] of this.userStreams) {
      userStream.writeStream.end();
    }

    // Build results from userFirstStart (which tracks ALL users who ever spoke,
    // even if their stream auto-closed due to silence)
    const files: string[] = [];
    const userMap = new Map<string, string>();
    const userStartTimes = new Map<string, number>();

    for (const [userId, info] of this.userFirstStart) {
      files.push(info.filePath);
      userMap.set(info.filePath, userId);
      userStartTimes.set(info.filePath, info.startedAt);
    }

    this.userStreams.clear();
    this.userFirstStart.clear();
    this.userLastChunkTime.clear();
    this.speaking.clear();

    return {
      files,
      userMap,
      userStartTimes,
      sessionStartedAt: this.sessionStartedAt,
      sessionDir: this.options.outputDir,
    };
  }

  getSpeakerCount(): number {
    return this.userStreams.size;
  }

  /**
   * Returns the timestamp (ms) of the last opus packet received from any user,
   * or 0 if no audio has ever been received in this session.
   */
  getLastVoiceActivityAt(): number {
    return this.lastVoiceActivityAt;
  }

  /**
   * Returns true if any opus audio has been received during this session.
   */
  hasReceivedAudio(): boolean {
    return this.lastVoiceActivityAt > 0;
  }
}