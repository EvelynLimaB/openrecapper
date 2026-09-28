import { VoiceWorker, StopResult } from '../workers/voice-worker';
import { TranscriptionService } from './transcription-service';
import { StorageService } from './storage-service';
import { SummaryService } from './summary-service';
import { RelayClient } from './relay-client';
import { LiveTranscriptionService } from './live-transcription-service';
import { CharacterModeService, SpeakerPresentation } from './character-mode-service';
import { RecorderPool, RecorderLease, NoRecorderAvailableError } from './recorder-pool';
import { Config } from '../config';
import { TextChannel, MessageCreateOptions } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { meetingFolderFromCallName } from './call-naming';

export interface RecordingSession {
  guildId: string;
  channelId: string;
  requesterId: string;
  textChannelId: string;
  callName: string;
  worker: VoiceWorker;
  liveTranscription: LiveTranscriptionService | null;
  // Snapshot taken before live transcription closes/clears session-only RPG state.
  finalSpeakerPresentations: Map<string, SpeakerPresentation> | null;
  startedAt: number;
  silenceCheckTimer: ReturnType<typeof setInterval> | null;
  sessionDir: string;
  activeMarkerPath: string;
  lease: RecorderLease;
}

export interface StartRecordingOptions {
  guildId: string;
  channelId: string;
  requesterId: string;
  textChannelId: string;
  // Human-readable call name (e.g. "CADS 2026-06-08"). Defaults are applied by
  // callers (scheduler / commands); falls back to a generic label if absent.
  callName?: string;
}

export interface OrphanSessionInfo {
  sessionDir: string;
  activeMarker: boolean;
  audioFiles: string[];
  transcriptFiles: string[];
}

export interface SessionInfo {
  guildId: string;
  channelId: string;
  startedAt: number;
  speakerCount: number;
  recorderLabel: string;
}

interface DeliveryArtifacts {
  sessionDir: string;
  combinedWavPath: string;
  srtPath?: string;
  txtPath?: string;
  metadataPath?: string;
  summaryPath?: string;
  transcriptText: string;
  transcriptSrt: string;
  summaryText: string | null;
  summaryTruncated: boolean;
  speakerNames: Map<string, string>;
  speakerCount: number;
  transcriptionFailed: boolean;
  transcriptionError?: string;
  r2Prefix: string;
  uploadWarning: string;
  relayWarning: string;
  emailWarning: string;
}

/**
 * Thrown when a start is requested for a channel that already has a live
 * recording (or one mid-startup). Callers turn this into a friendly message.
 */
export class AlreadyRecordingError extends Error {
  constructor(public readonly channelId: string) {
    super(`Already recording channel ${channelId}`);
    this.name = 'AlreadyRecordingError';
  }
}

export class WorkerManager {
  private static instance: WorkerManager;
  private sessions: Map<string, RecordingSession> = new Map();
  // Channels reserved for a recording that is mid-startup (between the
  // synchronous reservation and the moment its session lands in `sessions`).
  // This closes the window in which two near-simultaneous starts for the same
  // channel could both pass the check and put two different recorder bots into
  // one voice channel.
  private pendingChannels: Set<string> = new Set();

  // With N concurrent recordings, N sessions can end at once; mixdown is
  // CPU-heavy and Deepgram/relay calls are rate-limited, so post-processing
  // runs through this gate instead of all at once.
  private static readonly MAX_CONCURRENT_POSTPROCESS = 2;
  private activePostProcess = 0;
  private postProcessWaiters: Array<() => void> = [];

  /**
   * Synchronously reserve a channel for an incoming recording. Returns false
   * if the channel is already recording or mid-startup. Atomic by virtue of
   * running to completion with no `await` in between — this is the
   * authoritative one-bot-per-channel guard (the command-layer isRecording()
   * check is only a friendly fast-path).
   */
  private reserveChannel(channelId: string): boolean {
    if (this.sessions.has(channelId) || this.pendingChannels.has(channelId)) return false;
    this.pendingChannels.add(channelId);
    return true;
  }

  /** Drop a mid-startup reservation (on failure, or once the session is set). */
  private releasePendingChannel(channelId: string): void {
    this.pendingChannels.delete(channelId);
  }

  private async withPostProcessSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activePostProcess >= WorkerManager.MAX_CONCURRENT_POSTPROCESS) {
      await new Promise<void>((resolve) => this.postProcessWaiters.push(resolve));
    }
    this.activePostProcess++;
    try {
      return await fn();
    } finally {
      this.activePostProcess--;
      this.postProcessWaiters.shift()?.();
    }
  }

  static getInstance(): WorkerManager {
    if (!WorkerManager.instance) {
      WorkerManager.instance = new WorkerManager();
    }
    return WorkerManager.instance;
  }

  /** Find a guild text channel by its configured name. */
  private async findGuildTextChannel(
    guildId: string,
    channelName: string,
  ): Promise<TextChannel | null> {
    const { getClient } = require('../client');
    const client = getClient();
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    const wanted = channelName.trim().toLowerCase();
    if (!wanted) return null;

    try {
      const channels = await guild.channels.fetch();
      const match = channels.find((channel: any) => {
        if (!channel?.isTextBased?.() || !('send' in channel)) {
          return false;
        }
        return (
          'name' in channel &&
          typeof channel.name === 'string' &&
          channel.name.trim().toLowerCase() === wanted
        );
      });

      return (match && 'send' in match ? match : null) as TextChannel | null;
    } catch (err) {
      console.error(
        `[WorkerManager] Failed to find #${channelName} in guild ${guildId}:`,
        err,
      );
      return null;
    }
  }

  async startRecording(options: StartRecordingOptions): Promise<void> {
    // Reserve the target CHANNEL synchronously — before any await can run — so
    // two near-simultaneous starts for the same channel cannot both proceed
    // and put two different recorder bots into one voice channel.
    if (!this.reserveChannel(options.channelId)) {
      throw new AlreadyRecordingError(options.channelId);
    }

    // Reserve a recorder identity synchronously too, so two concurrent /record
    // calls cannot double-book a client.
    const pool = RecorderPool.getInstance();
    const lease = pool.allocate(options.guildId);
    if (!lease) {
      this.releasePendingChannel(options.channelId);
      throw new NoRecorderAvailableError(options.guildId, pool.capacityForGuild(options.guildId));
    }

    // Every failure path below must release the lease; the pending-channel
    // reservation is cleared in `finally` (on success the session in `sessions`
    // takes over as the authoritative reservation).
    try {
      const sessionStartedAt = Date.now();
      const sessionDir = path.join(
        Config.RECORDINGS_DIR,
        `${options.guildId}_${options.channelId}_${sessionStartedAt}`
      );
      fs.mkdirSync(sessionDir, { recursive: true });

      // Short token for Discord component custom IDs. The full session directory
      // name is intentionally not used because Discord limits custom IDs to 100 chars.
      const sessionToken = sessionStartedAt.toString(36);

      // RPG presentation uses dedicated channels so live captions never mix with
      // the character controls or the finalized transcript.
      let liveTranscription: LiveTranscriptionService | null = null;
      try {
        const { getClient } = require('../client');
        const client = getClient();
        const fallbackChannel = await client.channels.fetch(options.textChannelId) as TextChannel;
        const fallback = fallbackChannel?.isTextBased?.()
          ? (fallbackChannel as TextChannel)
          : null;

        const useDedicatedRpgChannels = CharacterModeService.isEnabled();
        const captionsChannel =
          (useDedicatedRpgChannels
            ? await this.findGuildTextChannel(
                options.guildId,
                Config.LIVE_CAPTIONS_CHANNEL_NAME,
              )
            : null) || fallback;
        const transcriptChannel =
          (useDedicatedRpgChannels
            ? await this.findGuildTextChannel(
                options.guildId,
                Config.TRANSCRIPT_CHANNEL_NAME,
              )
            : null) || fallback;

        if (captionsChannel && transcriptChannel) {
          liveTranscription = new LiveTranscriptionService(
            captionsChannel,
            transcriptChannel,
            options.channelId,
            sessionToken,
          );
          console.log(
            `[WorkerManager] RPG live captions -> #${captionsChannel.name}; controls/final transcript -> #${transcriptChannel.name}`,
          );
        }

        if (!captionsChannel) {
          console.warn(
            '[WorkerManager] No text-channel fallback is available; live transcription disabled.',
          );
        } else if (
          useDedicatedRpgChannels &&
          (!transcriptChannel ||
            transcriptChannel.name.trim().toLowerCase() !==
              Config.TRANSCRIPT_CHANNEL_NAME.trim().toLowerCase())
        ) {
          console.warn(
            `[WorkerManager] #${Config.TRANSCRIPT_CHANNEL_NAME} not found; character controls/final transcript will fall back to #${captionsChannel.name}.`,
          );
        }
      } catch (err) {
        console.error('[WorkerManager] Failed to set up live transcription:', err);
      }

      const activeMarkerPath = path.join(sessionDir, 'session.active');
      const callName = options.callName || `Call ${new Date().toISOString().slice(0, 10)}`;
      this.writeActiveMarker(activeMarkerPath, options, callName, sessionDir);

      const worker = new VoiceWorker({
        guildId: options.guildId,
        channelId: options.channelId,
        outputDir: sessionDir,
        client: lease.client,
        liveTranscription: liveTranscription || undefined,
      });

      try {
        await worker.start();
      } catch (err) {
        this.removeActiveMarker(activeMarkerPath);
        throw err;
      }

      const session: RecordingSession = {
        ...options,
        callName,
        worker,
        liveTranscription,
        finalSpeakerPresentations: null,
        startedAt: sessionStartedAt,
        silenceCheckTimer: null,
        sessionDir,
        activeMarkerPath,
        lease,
      };
      this.sessions.set(options.channelId, session);

      // The session is authoritative before interaction controls are published.
      if (liveTranscription) {
        await liveTranscription.postCharacterModePanel();
      }

      // Start silence-timeout monitoring if configured
      this.startSilenceMonitor(session);

      console.log(`[WorkerManager] Started recording "${callName}" in channel ${options.channelId}`);
    } catch (err) {
      pool.release(lease);
      throw err;
    } finally {
      this.releasePendingChannel(options.channelId);
    }
  }

  async stopRecording(channelId: string): Promise<{ fileCount: number; requesterId: string; sessionDir: string }> {
    const session = this.sessions.get(channelId);
    if (!session) {
      throw new Error('No active session for this channel');
    }

    // Clear silence-timeout timer
    if (session.silenceCheckTimer) {
      clearInterval(session.silenceCheckTimer);
      session.silenceCheckTimer = null;
    }

    // Snapshot RPG presentation before close() clears the session-only state.
    if (session.liveTranscription) {
      session.finalSpeakerPresentations =
        session.liveTranscription.getPresentationSnapshot();
    }

    // Close live transcription streams first to flush final results
    if (session.liveTranscription) {
      try {
        await session.liveTranscription.close();
        console.log('[WorkerManager] Live transcription closed');
      } catch (err) {
        console.error('[WorkerManager] Error closing live transcription:', err);
      }
    }

    const result = await session.worker.stop();
    const finalized = this.finalizeStoppedSession(session);

    console.log(`[WorkerManager] Stopped recording in channel ${channelId}, ${result.files.length} files`);

    // Kick off transcription in background only for the stop path that owns
    // finalization. A stale concurrent stop must not duplicate delivery.
    if (finalized) {
      this.withPostProcessSlot(() => this.transcribeAndDeliver(result, session)).catch((err) => {
        console.error('[WorkerManager] Transcription failed:', err);
      });
    }

    return {
      fileCount: result.files.length,
      requesterId: session.requesterId,
      sessionDir: result.sessionDir,
    };
  }

  private async transcribeAndDeliver(
    stopResult: StopResult,
    session: RecordingSession
  ): Promise<void> {
    const { files, userMap, userStartTimes, sessionStartedAt } = stopResult;
    const { getClient } = require('../client');
    const client = getClient();

    // Final RPG transcript delivery belongs in the dedicated #transcrição channel.
    // Keep the existing summary-channel override as the fallback for installations
    // that do not have the dedicated RPG channel.
    const { getSummaryChannelForGuild } = require('./summary-channel-store');
    let targetChannelId = session.textChannelId;
    let dedicatedTranscriptFound = false;
    try {
      const transcriptChannel = await this.findGuildTextChannel(
        session.guildId,
        Config.TRANSCRIPT_CHANNEL_NAME,
      );
      if (transcriptChannel) {
        targetChannelId = transcriptChannel.id;
        dedicatedTranscriptFound = true;
      }
    } catch (err) {
      console.error('[WorkerManager] Could not resolve dedicated transcript channel:', err);
    }

    if (!dedicatedTranscriptFound) {
      try {
        const overrideId = getSummaryChannelForGuild(session.guildId);
        if (overrideId) targetChannelId = overrideId;
      } catch (err) {
        console.error('[WorkerManager] Could not read summary channel override:', err);
      }
    }

    let textChannel: any;
    try {
      textChannel = await client.channels.fetch(targetChannelId);
    } catch (err) {
      console.error('[WorkerManager] Could not fetch final transcript channel, falling back to record channel:', err);
      if (targetChannelId !== session.textChannelId) {
        try {
          textChannel = await client.channels.fetch(session.textChannelId);
        } catch (err2) {
          console.error('[WorkerManager] Could not fetch fallback text channel:', err2);
        }
      }
    }

    if (files.length === 0) {
      console.log('[WorkerManager] No audio files to transcribe');
      if (textChannel?.isTextBased?.()) {
        await textChannel.send(`⚠️ Recording in <#${session.channelId}> ended with no audio captured.`);
      }
      return;
    }

    const artifacts = await this.prepareDeliveryArtifacts(
      stopResult,
      session,
      client,
    );
    await this.postDeliveryMessage(textChannel, session, artifacts, client);
  }

  private async prepareDeliveryArtifacts(
    stopResult: StopResult,
    session: RecordingSession,
    client: any
  ): Promise<DeliveryArtifacts> {
    const { files, userMap, userStartTimes, sessionStartedAt } = stopResult;
    const sessionDir = stopResult.sessionDir;
    const combinedPcmPath = path.join(sessionDir, 'combined.pcm');
    const combinedWavPath = path.join(sessionDir, 'recording.wav');

    await this.mixdownPcmFiles(files, userStartTimes, sessionStartedAt, combinedPcmPath);
    await this.pcmToWavStream(combinedPcmPath, combinedWavPath);

    const speakerNames = await this.resolveSpeakerNames(client, session.guildId, userMap);
    const presentationUsers = new Map<string, string>();

    for (const [userId, username] of speakerNames) {
      presentationUsers.set(
        userId,
        session.finalSpeakerPresentations?.get(userId)?.label || username,
      );
    }

    const rosterHeader = this.buildRosterHeader(presentationUsers);

    const transcriptionService = new TranscriptionService(Config.DEEPGRAM_API_KEY);
    const transcript = await this.transcribeWithRetry(
      transcriptionService,
      files,
      userMap,
      userStartTimes,
      sessionStartedAt,
      presentationUsers,
      sessionDir,
    );

    let transcriptText = '';
    let transcriptSrt = '';
    let speakerCount = 0;
    let transcriptionFailed = false;
    let transcriptionError: string | undefined;
    let txtPath: string | undefined;
    let srtPath: string | undefined;
    let metadataPath: string | undefined;
    let summaryPath: string | undefined;
    let summaryText: string | null = null;
    let summaryTruncated = false;
    let relayWarning = '';
    let emailWarning = '';

    if (transcript.ok) {
      transcriptText = transcript.value.text;
      transcriptSrt = transcript.value.srt;
      // Count actual Discord speakers, not presentation labels. Two users can
      // legally share a label when the DM impersonates a PC.
      speakerCount = speakerNames.size;

      srtPath = path.join(sessionDir, 'transcript.srt');
      txtPath = path.join(sessionDir, 'transcript.txt');
      metadataPath = path.join(sessionDir, 'metadata.json');
      fs.writeFileSync(srtPath, transcriptSrt);
      fs.writeFileSync(txtPath, rosterHeader + transcriptText);
      fs.writeFileSync(metadataPath, JSON.stringify({
        guildId: session.guildId,
        channelId: session.channelId,
        requesterId: session.requesterId,
        startedAt: new Date(session.startedAt).toISOString(),
        stoppedAt: new Date().toISOString(),
        speakers: Object.fromEntries(speakerNames),
        segmentCount: transcript.value.segments.length,
      }, null, 2));
      console.log(`[WorkerManager] Transcripts saved to ${sessionDir}`);

      summaryPath = path.join(sessionDir, 'summary.md');
      try {
        const participants = Array.from(presentationUsers.values());
        const generated = await SummaryService.summarize(rosterHeader + transcriptText, participants);
        if (generated) {
          const summaryDoc = `# ${session.callName} — Session Notes\n\n` +
            `${rosterHeader}${generated.text}\n`;
          summaryText = summaryDoc;
          summaryTruncated = generated.truncated;
          fs.writeFileSync(summaryPath, summaryDoc);
          console.log(`[WorkerManager] Summary saved to ${summaryPath}`);
        }
      } catch (err) {
        relayWarning = '⚠️ AI summary failed; transcript and audio are still available.';
        console.error('[WorkerManager] Summary generation failed:', err);
      }
    } else {
      transcriptionFailed = true;
      transcriptionError = transcript.error;
      speakerCount = speakerNames.size;
      transcriptText = `Transcription failed. Audio is stored in this session directory: ${sessionDir}`;
      transcriptSrt = '';
      const markerPath = path.join(sessionDir, 'transcription-failed.txt');
      fs.writeFileSync(
        markerPath,
        [
          `Transcription failed for ${session.callName}`,
          `Session: ${sessionDir}`,
          `Audio: ${combinedWavPath}`,
          `Time: ${new Date().toISOString()}`,
          `Error: ${transcriptionError}`,
        ].join('\n') + '\n',
        'utf8'
      );
      metadataPath = path.join(sessionDir, 'metadata.json');
      fs.writeFileSync(metadataPath, JSON.stringify({
        guildId: session.guildId,
        channelId: session.channelId,
        requesterId: session.requesterId,
        startedAt: new Date(session.startedAt).toISOString(),
        stoppedAt: new Date().toISOString(),
        speakers: Object.fromEntries(speakerNames),
        transcriptionFailed: true,
        transcriptionError,
      }, null, 2));
      console.error(`[WorkerManager] Transcription failed after retry; marker saved to ${markerPath}`);
    }

    let r2Prefix = '';
    let uploadWarning = '';
    if (StorageService.isConfigured()) {
      try {
        const storage = new StorageService();
        const uploadResult = await storage.uploadSession(sessionDir, meetingFolderFromCallName(session.callName));
        r2Prefix = uploadResult.prefix;
        console.log(`[WorkerManager] Uploaded to R2: ${r2Prefix}`);
      } catch (err) {
        uploadWarning = `⚠️ Cloud upload failed; files remain on the server at \`${sessionDir}\`.`;
        console.error('[WorkerManager] R2 upload failed:', err);
      }
    } else {
      uploadWarning = `⚠️ Cloud storage is not configured; files remain on the server at \`${sessionDir}\`.`;
      console.warn('[WorkerManager] R2 not configured, skipping cloud upload');
    }

    if (transcript.ok && Config.SUMMARY_EMAIL_TO && RelayClient.isConfigured()) {
      try {
        await this.emailSession(session, {
          sessionDir,
          combinedWavPath,
          srtPath,
          txtPath,
          metadataPath,
          summaryPath,
          transcriptText,
          transcriptSrt,
          summaryText,
          summaryTruncated,
          speakerNames,
          speakerCount,
          transcriptionFailed,
          transcriptionError,
          r2Prefix,
          uploadWarning,
          relayWarning,
          emailWarning,
        });
        console.log(`[WorkerManager] Emailed summary to ${Config.SUMMARY_EMAIL_TO}`);
      } catch (err) {
        emailWarning = '⚠️ Email delivery failed; results are posted here only.';
        console.error('[WorkerManager] Failed to email summary:', err);
      }
    }

    return {
      sessionDir,
      combinedWavPath,
      srtPath,
      txtPath,
      metadataPath,
      summaryPath,
      transcriptText,
      transcriptSrt,
      summaryText,
      summaryTruncated,
      speakerNames,
      speakerCount,
      transcriptionFailed,
      transcriptionError,
      r2Prefix,
      uploadWarning,
      relayWarning,
      emailWarning,
    };
  }

  private async resolveSpeakerNames(client: any, guildId: string, userMap: Map<string, string>): Promise<Map<string, string>> {
    const speakerNames: Map<string, string> = new Map();
    try {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        for (const [, userId] of userMap) {
          try {
            const member = await guild.members.fetch(userId);
            speakerNames.set(userId, member.displayName || member.user.username);
          } catch {
            speakerNames.set(userId, `User ${userId.slice(-4)}`);
          }
        }
      }
    } catch (err) {
      console.error('[WorkerManager] Error resolving speaker names:', err);
    }
    return speakerNames;
  }

  private buildRosterHeader(speakerNames: Map<string, string>): string {
    const rosterLines = Array.from(speakerNames.values()).map((name) => `  - ${name}`);
    return rosterLines.length > 0
      ? `Participants:\n${rosterLines.join('\n')}\n\n---\n\n`
      : '';
  }

  private async transcribeWithRetry(
    transcriptionService: TranscriptionService,
    files: string[],
    userMap: Map<string, string>,
    userStartTimes: Map<string, number>,
    sessionStartedAt: number,
    speakerNames: Map<string, string>,
    sessionDir: string
  ): Promise<
    | { ok: true; value: Awaited<ReturnType<TranscriptionService['transcribeUserTracks']>> }
    | { ok: false; error: string }
  > {
    const tracks = files.map((filePath) => {
      const userId = userMap.get(filePath) || path.basename(filePath, path.extname(filePath));
      return {
        filePath,
        userId,
        speakerName:
          speakerNames.get(userId) ||
          `User ${userId.slice(-4)}`,
        startedAt: userStartTimes.get(filePath) ?? sessionStartedAt,
      };
    });

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          console.log('[WorkerManager] Retrying per-user Deepgram transcription after backoff');
          await WorkerManager.sleep(10_000);
        }
        return { ok: true, value: await transcriptionService.transcribeUserTracks(tracks, sessionStartedAt) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WorkerManager] Per-user Deepgram transcription attempt ${attempt}/2 failed for ${sessionDir}:`, err);
        if (attempt === 2) return { ok: false, error: msg };
      }
    }
    return { ok: false, error: 'unknown transcription failure' };
  }

  private async emailSession(session: RecordingSession, artifacts: DeliveryArtifacts): Promise<void> {
    const durSec = Math.round((Date.now() - session.startedAt) / 1000);
    const durStr = `${Math.floor(durSec / 60)}m ${durSec % 60}s`;
    const participantList = Array.from(artifacts.speakerNames.values()).join(', ') || '(names not detected)';
    const publicBase = Config.R2_PUBLIC_URL;
    let links = '';
    if (artifacts.r2Prefix && publicBase) {
      links = `\n\nDownloads:\n` +
        (artifacts.summaryText ? `  Summary (.md): ${publicBase}/${artifacts.r2Prefix}/summary.md\n` : '') +
        `  Transcript (.txt): ${publicBase}/${artifacts.r2Prefix}/transcript.txt\n` +
        `  Subtitles (.srt): ${publicBase}/${artifacts.r2Prefix}/transcript.srt\n` +
        `  Audio (.wav): ${publicBase}/${artifacts.r2Prefix}/recording.wav`;
    }
    const bodyParts = [
      `${session.callName}`,
      ``,
      `Duration: ${durStr}`,
      `Speakers: ${artifacts.speakerCount}`,
      `Participants: ${participantList}`,
      links ? links.trimStart() : '',
      artifacts.uploadWarning || '',
      artifacts.relayWarning || '',
      ``,
      `---`,
      ``,
      artifacts.summaryText ? artifacts.summaryText : '(No AI summary was generated for this session.)',
      ``,
      `---`,
      `Full transcript:`,
      ``,
      artifacts.transcriptText,
    ].filter((part) => part !== '');
    await RelayClient.email(
      Config.SUMMARY_EMAIL_TO,
      `[${Config.BOT_NAME}] ${session.callName} — notes & transcript`,
      bodyParts.join('\n')
    );
  }

  private async postDeliveryMessage(
    textChannel: any,
    session: RecordingSession,
    artifacts: DeliveryArtifacts,
    client: any
  ): Promise<void> {
    const durationSec = Math.round((Date.now() - session.startedAt) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    const warnings = [artifacts.uploadWarning, artifacts.relayWarning, artifacts.emailWarning].filter(Boolean);

    if (artifacts.transcriptionFailed) {
      warnings.unshift(`⚠️ Deepgram transcription failed after retry; audio is preserved at \`${artifacts.sessionDir}\`.`);
    }

    // Small text artifacts ride with the main message; the (potentially large)
    // audio is sent separately so a size failure on the audio never suppresses
    // the summary + R2 links.
    const textAttachments: NonNullable<MessageCreateOptions['files']>[number][] = [];
    if (!artifacts.transcriptionFailed) {
      textAttachments.push(
        { attachment: Buffer.from(artifacts.transcriptText), name: 'transcript.txt' },
        { attachment: Buffer.from(artifacts.transcriptSrt), name: 'transcript.srt' },
      );
      if (artifacts.summaryText) textAttachments.unshift({ attachment: Buffer.from(artifacts.summaryText), name: 'summary.md' });
    }

    // Discord's per-request upload limit for non-boosted guilds is ~10MB, so
    // only attach the wav when it comfortably fits; otherwise rely on the R2
    // link. (The old 25MB guard let 21MB files through and 413'd the whole post.)
    const WAV_ATTACH_LIMIT = 8 * 1024 * 1024;
    let wavAttachment: NonNullable<MessageCreateOptions['files']>[number] | null = null;
    if (fs.existsSync(artifacts.combinedWavPath)) {
      const wavSize = fs.statSync(artifacts.combinedWavPath).size;
      if (wavSize < WAV_ATTACH_LIMIT) {
        wavAttachment = { attachment: artifacts.combinedWavPath, name: 'recording.wav' };
      } else {
        console.log(`[WorkerManager] Audio file too large for Discord (${(wavSize / 1024 / 1024).toFixed(1)}MB), skipping attachment (available via R2 link)`);
      }
    }

    let r2Note = '';
    if (artifacts.r2Prefix) {
      const publicBase = Config.R2_PUBLIC_URL;
      if (publicBase) {
        r2Note = `\n\n📁 **Recordings:**\n` +
          (artifacts.summaryText ? `📝 Summary: ${publicBase}/${artifacts.r2Prefix}/summary.md\n` : '') +
          (artifacts.transcriptionFailed ? '' : `📄 Transcript: ${publicBase}/${artifacts.r2Prefix}/transcript.txt\n`) +
          (artifacts.transcriptionFailed ? '' : `🎬 Subtitles: ${publicBase}/${artifacts.r2Prefix}/transcript.srt\n`) +
          `🔊 Audio: ${publicBase}/${artifacts.r2Prefix}/recording.wav`;
      } else {
        r2Note = `\n**Archived:** \`${artifacts.r2Prefix}\``;
      }
    }

    const statusTitle = artifacts.transcriptionFailed ? 'recording saved; transcription failed' : 'transcription complete';
    const warningNote = warnings.length ? `\n\n${warnings.join('\n')}` : '';
    const content = `📝 **${session.callName}** — ${statusTitle} for <#${session.channelId}>\n\n` +
      `**Duration:** ${mins}m ${secs}s\n` +
      `**Speakers:** ${artifacts.speakerCount}\n` +
      `**Requested by:** <@${session.requesterId}>${r2Note}${warningNote}`;

    const target = textChannel?.isTextBased?.()
      ? textChannel
      : (console.warn('[WorkerManager] Text channel not available, falling back to DM'),
         await client.users.fetch(session.requesterId).catch((err: unknown) => {
           console.error('[WorkerManager] Failed to fetch requester for DM:', err);
           return null;
         }));
    if (!target) return;

    // 1) Main message: summary text + R2 links + small text artifacts. Retry
    //    without attachments if the attachments push it over the size limit, so
    //    the summary and links always get through.
    try {
      await target.send({ content, files: textAttachments });
    } catch (err) {
      console.error('[WorkerManager] Failed to post delivery message with attachments, retrying without:', err);
      try {
        await target.send({ content });
      } catch (err2) {
        console.error('[WorkerManager] Failed to post delivery message even without attachments:', err2);
      }
    }

    // 2) Audio as a separate follow-up so a size failure here can't suppress
    //    the summary above.
    if (wavAttachment) {
      try {
        await target.send({ content: '🔊 Audio recording:', files: [wavAttachment] });
      } catch (err) {
        console.error('[WorkerManager] Failed to post audio attachment (available via R2 link):', err);
      }
    }

    // 3) Summary body as chunked follow-up messages.
    if (artifacts.summaryText) {
      const chunks = WorkerManager.chunkText(artifacts.summaryText);
      for (let i = 0; i < chunks.length; i++) {
        const suffix = chunks.length > 1 ? `\n\n*(${i + 1}/${chunks.length})*` : '';
        try {
          await target.send({ content: chunks[i] + suffix });
        } catch (err) {
          console.error(`[WorkerManager] Failed to post summary chunk ${i + 1}/${chunks.length}:`, err);
        }
      }

      // 4) If the model hit the hard token cap, the summary above is cut off —
      //    tell readers where the full transcript is so they can summarize it
      //    with their own LLM.
      if (artifacts.summaryTruncated) {
        try {
          await target.send({
            content: '⚠️ The AI summary above hit its length limit and is cut off at the end. ' +
              'For complete notes, download `transcript.txt` (attached above) and generate a summary with your own LLM.',
          });
        } catch (err) {
          console.error('[WorkerManager] Failed to post summary-truncated notice:', err);
        }
      }
    }
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Mix multiple per-user PCM files into a single combined PCM file.
   * Each user's audio is offset by their start time relative to session start,
   * so they align temporally. Mixing is done sample-by-sample with saturation clipping.
   * 
   * Audio format: 48kHz, 16-bit signed LE, stereo (4 bytes per sample frame).
   * Processing is done in chunks to keep memory usage bounded.
   */
  /**
   * Split text into chunks that each fit within Discord's message limit.
   * Prefers to break on paragraph (blank line) then line boundaries to keep
   * Markdown readable; hard-splits only as a last resort for very long lines.
   */
  private static chunkText(text: string, limit = 1900): string[] {
    const chunks: string[] = [];
    let current = '';

    const pushCurrent = () => {
      if (current.trim().length > 0) chunks.push(current.replace(/\n+$/, ''));
      current = '';
    };

    for (const para of text.split('\n\n')) {
      const block = para + '\n\n';
      if (block.length > limit) {
        // Paragraph itself too big: fall back to line-by-line.
        pushCurrent();
        for (const line of para.split('\n')) {
          let ln = line;
          while (ln.length > limit) {
            // Last resort: hard-split an over-long single line.
            pushCurrent();
            chunks.push(ln.slice(0, limit));
            ln = ln.slice(limit);
          }
          if (current.length + ln.length + 1 > limit) pushCurrent();
          current += ln + '\n';
        }
        current += '\n';
        continue;
      }
      if (current.length + block.length > limit) pushCurrent();
      current += block;
    }
    pushCurrent();
    return chunks.length ? chunks : [''];
  }

  private async mixdownPcmFiles(
    files: string[],
    userStartTimes: Map<string, number>,
    sessionStartedAt: number,
    outputPath: string
  ): Promise<void> {
    const SAMPLE_RATE = 48000;
    const CHANNELS = 2;
    const BYTES_PER_SAMPLE = 2; // 16-bit
    const FRAME_SIZE = CHANNELS * BYTES_PER_SAMPLE; // 4 bytes per sample frame
    const BYTES_PER_MS = SAMPLE_RATE * FRAME_SIZE / 1000; // bytes per millisecond

    // Filter to valid, non-empty PCM files
    const validFiles = files.filter(f => fs.existsSync(f) && fs.statSync(f).size > 0);
    if (validFiles.length === 0) {
      // Write empty file
      fs.writeFileSync(outputPath, Buffer.alloc(0));
      return;
    }

    // Calculate each file's offset in bytes from session start
    interface TrackInfo {
      filePath: string;
      offsetBytes: number; // how many zero bytes to prepend
      fileSize: number;    // actual PCM data size
      totalBytes: number;  // offsetBytes + fileSize
    }

    const tracks: TrackInfo[] = validFiles.map(filePath => {
      const startTime = userStartTimes.get(filePath) ?? sessionStartedAt;
      const offsetMs = Math.max(0, startTime - sessionStartedAt);
      // Align offset to frame boundary (multiple of FRAME_SIZE)
      const rawOffsetBytes = Math.round(offsetMs * BYTES_PER_MS);
      const offsetBytes = Math.floor(rawOffsetBytes / FRAME_SIZE) * FRAME_SIZE;
      const fileSize = fs.statSync(filePath).size;
      // Truncate fileSize to frame boundary
      const alignedFileSize = Math.floor(fileSize / FRAME_SIZE) * FRAME_SIZE;
      return {
        filePath,
        offsetBytes,
        fileSize: alignedFileSize,
        totalBytes: offsetBytes + alignedFileSize,
      };
    });

    // Total output length = max of (offset + file size) across all tracks
    const totalOutputBytes = Math.max(...tracks.map(t => t.totalBytes));
    if (totalOutputBytes === 0) {
      fs.writeFileSync(outputPath, Buffer.alloc(0));
      return;
    }

    console.log(`[WorkerManager] Mixing ${tracks.length} tracks, output length: ${(totalOutputBytes / BYTES_PER_MS / 1000).toFixed(1)}s`);
    for (const t of tracks) {
      console.log(`[WorkerManager]   Track ${path.basename(t.filePath)}: offset=${(t.offsetBytes / BYTES_PER_MS / 1000).toFixed(1)}s, duration=${(t.fileSize / BYTES_PER_MS / 1000).toFixed(1)}s`);
    }

    // Process in chunks to keep memory bounded
    // 1 second of audio = 48000 * 4 = 192000 bytes. Use 5-second chunks.
    const CHUNK_BYTES = SAMPLE_RATE * FRAME_SIZE * 5; // 5 seconds = 960000 bytes

    const writeStream = fs.createWriteStream(outputPath);

    // Open file descriptors for all tracks
    const fds = tracks.map(t => fs.openSync(t.filePath, 'r'));

    try {
      let outputPosition = 0;

      while (outputPosition < totalOutputBytes) {
        const chunkSize = Math.min(CHUNK_BYTES, totalOutputBytes - outputPosition);
        const chunkEnd = outputPosition + chunkSize;

        // Start with silence
        const mixBuffer = Buffer.alloc(chunkSize, 0);

        for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
          const track = tracks[trackIdx];
          const fd = fds[trackIdx];

          // This track's audio occupies [track.offsetBytes, track.offsetBytes + track.fileSize) in output space
          const trackDataStart = track.offsetBytes;
          const trackDataEnd = track.offsetBytes + track.fileSize;

          // Find overlap between this chunk and this track's data region
          const overlapStart = Math.max(outputPosition, trackDataStart);
          const overlapEnd = Math.min(chunkEnd, trackDataEnd);

          if (overlapStart >= overlapEnd) continue; // No overlap

          const overlapLength = overlapEnd - overlapStart;

          // Read from the file at the corresponding offset
          const fileReadOffset = overlapStart - trackDataStart;
          const trackBuf = Buffer.alloc(overlapLength);
          const bytesRead = fs.readSync(fd, trackBuf, 0, overlapLength, fileReadOffset);

          if (bytesRead === 0) continue;

          // Mix into the output buffer
          const mixOffset = overlapStart - outputPosition;
          const samplesToMix = Math.floor(bytesRead / BYTES_PER_SAMPLE);

          for (let i = 0; i < samplesToMix; i++) {
            const bytePos = i * BYTES_PER_SAMPLE;
            const mixBytePos = mixOffset + bytePos;

            // Read current mix value and track value as int16 LE
            const mixVal = mixBuffer.readInt16LE(mixBytePos);
            const trackVal = trackBuf.readInt16LE(bytePos);

            // Add with saturation clipping
            const sum = mixVal + trackVal;
            const clipped = Math.max(-32768, Math.min(32767, sum));
            mixBuffer.writeInt16LE(clipped, mixBytePos);
          }
        }

        // Write chunk, applying backpressure
        const canContinue = writeStream.write(mixBuffer);
        if (!canContinue) {
          await new Promise<void>(resolve => writeStream.once('drain', resolve));
        }

        outputPosition += chunkSize;
      }
    } finally {
      // Close all file descriptors
      for (const fd of fds) {
        fs.closeSync(fd);
      }
    }

    // Finish writing
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    console.log(`[WorkerManager] Mixdown complete: ${outputPath} (${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)}MB)`);
  }

  private async pcmToWavStream(pcmPath: string, wavPath: string): Promise<void> {
    const sampleRate = 48000;
    const channels = 2;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = fs.statSync(pcmPath).size;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    const writeStream = fs.createWriteStream(wavPath);
    writeStream.write(header);

    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(pcmPath);
      readStream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      readStream.on('error', reject);
    });
  }

  async stopAllActiveSessions(reason: string): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    console.log(`[WorkerManager] Stopping ${sessions.length} active session(s): ${reason}`);
    for (const session of sessions) {
      try {
        await this.stopRecording(session.channelId);
      } catch (err) {
        console.error(`[WorkerManager] Failed to stop session ${session.channelId} during ${reason}:`, err);
      }
    }
  }

  sweepOrphanSessions(): OrphanSessionInfo[] {
    const root = Config.RECORDINGS_DIR;
    const orphans: OrphanSessionInfo[] = [];
    if (!fs.existsSync(root)) return orphans;

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(root, entry.name);
      const files = fs.readdirSync(sessionDir);
      const audioFiles = files.filter((f) => f.endsWith('.wav') || f.endsWith('.pcm'));
      const transcriptFiles = files.filter((f) => f === 'transcript.txt' || f === 'transcript.srt');
      const activeMarker = files.includes('session.active');
      if (activeMarker || (audioFiles.length > 0 && transcriptFiles.length === 0)) {
        orphans.push({ sessionDir, activeMarker, audioFiles, transcriptFiles });
      }
    }

    for (const orphan of orphans) {
      console.warn(
        `[Recovery] Orphan recording dir detected: ${orphan.sessionDir} ` +
        `(activeMarker=${orphan.activeMarker}, audio=${orphan.audioFiles.length}, transcripts=${orphan.transcriptFiles.length})`
      );
    }
    return orphans;
  }

  private writeActiveMarker(
    markerPath: string,
    options: StartRecordingOptions,
    callName: string,
    sessionDir: string
  ): void {
    fs.writeFileSync(markerPath, JSON.stringify({
      guildId: options.guildId,
      channelId: options.channelId,
      requesterId: options.requesterId,
      textChannelId: options.textChannelId,
      callName,
      sessionDir,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    }, null, 2) + '\n', 'utf8');
  }

  private removeActiveMarker(markerPath: string): void {
    try {
      if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    } catch (err) {
      console.error(`[WorkerManager] Failed to remove active marker ${markerPath}:`, err);
    }
  }

  /**
   * Finalize a stopped session exactly once. Stop paths can race (manual stop,
   * empty-channel auto-stop, silence auto-stop), so never delete/release by
   * channel id alone: a stale stop could otherwise release a recorder lease now
   * owned by a newer same-guild session.
   */
  private finalizeStoppedSession(session: RecordingSession): boolean {
    if (this.sessions.get(session.channelId) !== session) return false;
    this.sessions.delete(session.channelId);
    this.removeActiveMarker(session.activeMarkerPath);
    RecorderPool.getInstance().release(session.lease);
    return true;
  }

  isRecording(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  getSession(channelId: string): RecordingSession | undefined {
    return this.sessions.get(channelId);
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      guildId: s.guildId,
      channelId: s.channelId,
      startedAt: s.startedAt,
      speakerCount: s.worker.getSpeakerCount(),
      recorderLabel: s.lease.label,
    }));
  }

  /**
   * Start a periodic check for silence timeout on a recording session.
   * If no opus packets have been received for SILENCE_TIMEOUT_MINUTES,
   * the bot auto-stops the recording, leaves the voice channel, and
   * cleans up the empty session directory.
   */
  private startSilenceMonitor(session: RecordingSession): void {
    const timeoutMinutes = Config.SILENCE_TIMEOUT_MINUTES;
    if (timeoutMinutes <= 0) {
      console.log(`[SilenceMonitor] Disabled (SILENCE_TIMEOUT_MINUTES=0)`);
      return;
    }

    const timeoutMs = timeoutMinutes * 60 * 1000;
    // Check every 60 seconds
    const CHECK_INTERVAL_MS = 60_000;

    console.log(`[SilenceMonitor] Monitoring channel ${session.channelId} — timeout: ${timeoutMinutes} min`);

    session.silenceCheckTimer = setInterval(async () => {
      const lastActivity = session.worker.getLastVoiceActivityAt();
      const now = Date.now();

      // If no audio has ever been received, measure from session start
      const referenceTime = lastActivity > 0 ? lastActivity : session.startedAt;
      const silentMs = now - referenceTime;

      if (silentMs >= timeoutMs) {
        console.log(
          `[SilenceMonitor] No voice activity for ${Math.round(silentMs / 60000)} min ` +
          `in channel ${session.channelId} — auto-stopping`
        );
        await this.silenceAutoStop(session);
      }
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Auto-stop a recording session due to silence timeout.
   * Leaves the voice channel, posts a message, and cleans up the empty
   * session directory. Does NOT kick off transcription (there's nothing
   * to transcribe).
   */
  private async silenceAutoStop(session: RecordingSession): Promise<void> {
    const channelId = session.channelId;

    // Prevent double-stop if this fires while a manual stop is in progress
    if (!this.sessions.has(channelId)) return;

    // Clear the timer first to prevent re-entry
    if (session.silenceCheckTimer) {
      clearInterval(session.silenceCheckTimer);
      session.silenceCheckTimer = null;
    }

    // Snapshot character presentation before close() clears the session state.
    if (session.liveTranscription) {
      try {
        session.finalSpeakerPresentations =
          session.liveTranscription.getPresentationSnapshot();

        await session.liveTranscription.close();
      } catch (err) {
        console.error('[SilenceMonitor] Error closing live transcription:', err);
      }
    }

    // Capture audio state BEFORE stop() (which may clear internal state)
    const hadAudio = session.worker.hasReceivedAudio();

    // Stop the worker (disconnects from voice)
    const result = await session.worker.stop();
    const finalized = this.finalizeStoppedSession(session);
    const sessionDir = result.sessionDir;

    if (!finalized) {
      console.log(`[SilenceMonitor] Session ${channelId} was already finalized by another stop path`);
      return;
    }

    console.log(
      `[SilenceMonitor] Stopped recording in channel ${channelId} ` +
      `(hadAudio=${hadAudio}, files=${result.files.length})`
    );

    // Clean up the empty recording directory if no audio was ever captured
    if (!hadAudio && fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`[SilenceMonitor] Cleaned up empty session dir: ${sessionDir}`);
      } catch (err) {
        console.error(`[SilenceMonitor] Failed to clean up session dir:`, err);
      }
    }

    // Post a brief message to the text channel
    try {
      const { getClient } = require('../client');
      const client = getClient();
      const textChannel = await client.channels.fetch(session.textChannelId);
      if (textChannel?.isTextBased?.()) {
        const timeoutMinutes = Config.SILENCE_TIMEOUT_MINUTES;
        await (textChannel as TextChannel).send(
          `🔇 Recording ended — no voice activity detected for ${timeoutMinutes} minutes. ` +
          `Leaving <#${channelId}>.`
        );
      }
    } catch (err) {
      console.error('[SilenceMonitor] Failed to post timeout message:', err);
    }
  }
}
