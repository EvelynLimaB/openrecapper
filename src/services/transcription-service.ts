import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CampaignTermsService } from './campaign-terms-service';

interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

interface TranscriptResult {
  srt: string;
  text: string;
  segments: Segment[];
}

interface TranscriptionServiceOptions {
  /** Maximum duration of each normal PCM block, in seconds. */
  chunkSeconds?: number;
  /** Audio overlap around each block boundary, in seconds. */
  overlapSeconds?: number;
  /** A 504 response triggers recursive splitting down to this duration. */
  minSplitSeconds?: number;
}

class DeepgramRequestError extends Error {
  constructor(public readonly statusCode: number, body: string) {
    super(`Deepgram API error ${statusCode}: ${body}`);
    this.name = 'DeepgramRequestError';
  }
}

interface ChunkCheckpoint {
  version: 1;
  startByte: number;
  endByte: number;
  segments: Segment[];
}

const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_FRAME_BYTES = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_FRAME_BYTES;

export interface UserTrackInput {
  filePath: string;
  userId: string;
  speakerName: string;
  /** Absolute wall-clock timestamp (ms) when this user's PCM starts. */
  startedAt: number;
}

export class TranscriptionService {
  private apiKey: string;
  private chunkSeconds: number;
  private overlapSeconds: number;
  private minSplitSeconds: number;

  constructor(apiKey: string, options: TranscriptionServiceOptions = {}) {
    this.apiKey = apiKey;
    this.chunkSeconds = options.chunkSeconds ?? 300;
    this.overlapSeconds = options.overlapSeconds ?? 2;
    this.minSplitSeconds = options.minSplitSeconds ?? 30;

    if (!Number.isInteger(this.chunkSeconds) || this.chunkSeconds < 1) {
      throw new Error('chunkSeconds must be a positive integer.');
    }
    if (!Number.isFinite(this.overlapSeconds) || this.overlapSeconds < 0) {
      throw new Error('overlapSeconds must be a non-negative number.');
    }
    if (!Number.isFinite(this.minSplitSeconds) || this.minSplitSeconds <= 0) {
      throw new Error('minSplitSeconds must be a positive number.');
    }
  }

  /**
   * Transcribe each user's raw PCM track independently and interleave the
   * timestamped results with the known Discord display names.
   *
   * Recorded PCM format: 48 kHz, 16-bit signed LE, stereo. Each file begins at
   * that user's first-audio wall-clock offset and already contains silence-filled
   * gaps, so Deepgram timestamps can be shifted by that offset and merged.
   */
  async transcribeUserTracks(
    tracks: UserTrackInput[],
    sessionStartedAt: number,
    checkpointRoot?: string,
  ): Promise<TranscriptResult> {
    const segments: Segment[] = [];
    const validTracks = tracks.filter((track) => {
      if (!fs.existsSync(track.filePath)) return false;
      const stats = fs.statSync(track.filePath);
      if (stats.size < 1000) {
        console.log(`[Transcription] ${path.basename(track.filePath)} too small, skipping`);
        return false;
      }
      return true;
    });

    if (validTracks.length === 0) {
      console.log('[Transcription] No usable per-user audio files, skipping');
      return { srt: '', text: 'No audio captured.', segments: [] };
    }

    const params = this.buildPcmParams();

    // Fingerprint the input so checkpoints are never reused after an audio file,
    // speaker label, offset, or chunking configuration changes.
    const fingerprintInput = validTracks.map((track) => {
      const stats = fs.statSync(track.filePath);
      return {
        file: path.basename(track.filePath),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        userId: track.userId,
        speakerName: track.speakerName,
        startedAt: track.startedAt,
      };
    });
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        version: 1,
        sessionStartedAt,
        chunkSeconds: this.chunkSeconds,
        overlapSeconds: this.overlapSeconds,
        minSplitSeconds: this.minSplitSeconds,
        requestParams: params.toString(),
        tracks: fingerprintInput,
      }))
      .digest('hex')
      .slice(0, 20);
    const progressBase = checkpointRoot ||
      path.join(path.dirname(validTracks[0].filePath), 'transcription-progress');
    const progressDir = path.join(progressBase, `v1-${fingerprint}`);
    fs.mkdirSync(progressDir, { recursive: true });

    console.log(
      `[Transcription] Transcribing ${validTracks.length} per-user track(s) with Deepgram Nova-3; ` +
      `blocks=${this.chunkSeconds}s, overlap=${this.overlapSeconds}s, checkpoints=${progressDir}`,
    );

    // Sequential calls limit concurrent API load. Every successful core block
    // is persisted so a later request failure does not discard completed work.
    for (const track of validTracks) {
      const offsetSeconds = Math.max(0, (track.startedAt - sessionStartedAt) / 1000);
      const trackSegments = await this.transcribeTrackInChunks(
        track,
        offsetSeconds,
        params,
        progressDir,
      );
      segments.push(...trackSegments);
    }

    segments.sort((a, b) =>
      a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker),
    );
    console.log(`[Transcription] Got ${segments.length} named segment(s) from Deepgram`);

    return {
      srt: this.toSRT(segments),
      text: this.toPlainText(segments),
      segments,
    };
  }

  private buildPcmParams(): URLSearchParams {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'multi',
      encoding: 'linear16',
      sample_rate: '48000',
      channels: '2',
      smart_format: 'true',
      utterances: 'true',
      punctuate: 'true',
      paragraphs: 'true',
    });

    const campaignTerms = CampaignTermsService.load();
    CampaignTermsService.applyToParams(params, campaignTerms);
    return params;
  }

  private async transcribeTrackInChunks(
    track: UserTrackInput,
    trackOffsetSeconds: number,
    params: URLSearchParams,
    progressDir: string,
  ): Promise<Segment[]> {
    const stats = fs.statSync(track.filePath);
    const totalBytes = Math.floor(stats.size / PCM_FRAME_BYTES) * PCM_FRAME_BYTES;
    if (totalBytes !== stats.size) {
      console.warn(
        `[Transcription] ${path.basename(track.filePath)} has ${stats.size - totalBytes} trailing byte(s) ` +
        'that do not form a complete stereo PCM frame; ignoring them.',
      );
    }

    const trackId = (track.userId ||
      path.basename(track.filePath, path.extname(track.filePath)))
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const coreBlockBytes = this.chunkSeconds * PCM_BYTES_PER_SECOND;
    const trackSegments: Segment[] = [];

    for (let startByte = 0; startByte < totalBytes; startByte += coreBlockBytes) {
      const endByte = Math.min(totalBytes, startByte + coreBlockBytes);
      const blockSegments = await this.transcribeRangeWithRecovery(
        track,
        trackId,
        trackOffsetSeconds,
        totalBytes,
        startByte,
        endByte,
        params,
        progressDir,
      );
      trackSegments.push(...blockSegments);
    }

    console.log(
      `[Transcription] Completed ${track.speakerName}: ${trackSegments.length} segment(s) from ` +
      `${Math.ceil(totalBytes / coreBlockBytes)} core block(s)`,
    );
    return trackSegments;
  }

  private async transcribeRangeWithRecovery(
    track: UserTrackInput,
    trackId: string,
    trackOffsetSeconds: number,
    totalBytes: number,
    coreStartByte: number,
    coreEndByte: number,
    params: URLSearchParams,
    progressDir: string,
  ): Promise<Segment[]> {
    const checkpointPath = path.join(
      progressDir,
      `${trackId}-${coreStartByte}-${coreEndByte}.json`,
    );

    if (fs.existsSync(checkpointPath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as ChunkCheckpoint;
        if (
          saved.version === 1 &&
          saved.startByte === coreStartByte &&
          saved.endByte === coreEndByte &&
          Array.isArray(saved.segments)
        ) {
          console.log(
            `[Transcription] Reusing checkpoint ${track.speakerName} bytes ${coreStartByte}-${coreEndByte}`,
          );
          return saved.segments;
        }
      } catch (err) {
        console.warn(`[Transcription] Ignoring invalid checkpoint ${checkpointPath}:`, err);
      }
    }

    const overlapBytes = Math.floor(
      (this.overlapSeconds * PCM_BYTES_PER_SECOND) / PCM_FRAME_BYTES,
    ) * PCM_FRAME_BYTES;
    const requestStartByte = Math.max(0, coreStartByte - overlapBytes);
    const requestEndByte = Math.min(totalBytes, coreEndByte + overlapBytes);
    const requestBytes = requestEndByte - requestStartByte;
    const coreStartSeconds = trackOffsetSeconds + coreStartByte / PCM_BYTES_PER_SECOND;
    const coreEndSeconds = trackOffsetSeconds + coreEndByte / PCM_BYTES_PER_SECOND;
    const requestOffsetSeconds = trackOffsetSeconds + requestStartByte / PCM_BYTES_PER_SECOND;

    let result: any;
    try {
      const sizeMiB = (requestBytes / 1024 / 1024).toFixed(1);
      console.log(
        `[Transcription] Sending ${track.speakerName} block ` +
        `[${(coreStartByte / PCM_BYTES_PER_SECOND).toFixed(1)}s-${(coreEndByte / PCM_BYTES_PER_SECOND).toFixed(1)}s] ` +
        `(${sizeMiB}MiB including overlap)`,
      );
      result = await this.postToDeepgramStream(
        fs.createReadStream(track.filePath, {
          start: requestStartByte,
          end: requestEndByte - 1,
        }),
        requestBytes,
        params,
        'audio/raw',
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const blockDurationSeconds = (coreEndByte - coreStartByte) / PCM_BYTES_PER_SECOND;
      const isGatewayTimeout =
        error instanceof DeepgramRequestError && error.statusCode === 504;

      if (isGatewayTimeout && blockDurationSeconds > this.minSplitSeconds) {
        const midpointRaw = Math.floor((coreStartByte + coreEndByte) / 2);
        const midpointByte = Math.floor(midpointRaw / PCM_FRAME_BYTES) * PCM_FRAME_BYTES;
        if (midpointByte > coreStartByte && midpointByte < coreEndByte) {
          console.warn(
            `[Transcription] Deepgram returned 504 for ${track.speakerName} ` +
            `(${blockDurationSeconds.toFixed(1)}s); splitting block into smaller ranges.`,
          );
          const left = await this.transcribeRangeWithRecovery(
            track, trackId, trackOffsetSeconds, totalBytes,
            coreStartByte, midpointByte, params, progressDir,
          );
          const right = await this.transcribeRangeWithRecovery(
            track, trackId, trackOffsetSeconds, totalBytes,
            midpointByte, coreEndByte, params, progressDir,
          );

          // Cache the completed parent range too. Without this, a resumed run
          // would repeat the original request that returned 504 before reusing
          // the successful child checkpoints.
          const splitSegments = [...left, ...right];
          const splitCheckpoint: ChunkCheckpoint = {
            version: 1,
            startByte: coreStartByte,
            endByte: coreEndByte,
            segments: splitSegments,
          };
          const splitTemporaryPath = `${checkpointPath}.${process.pid}.tmp`;
          try {
            fs.writeFileSync(splitTemporaryPath, JSON.stringify(splitCheckpoint), 'utf8');
            fs.renameSync(splitTemporaryPath, checkpointPath);
          } finally {
            if (fs.existsSync(splitTemporaryPath)) {
              fs.rmSync(splitTemporaryPath, { force: true });
            }
          }
          console.log(
            `[Transcription] Saved completed split checkpoint for ${track.speakerName}: ` +
            `bytes ${coreStartByte}-${coreEndByte}`,
          );
          return splitSegments;
        }
      }

      throw new Error(
        `Transcription block failed for ${track.speakerName} ` +
        `[${(coreStartByte / PCM_BYTES_PER_SECOND).toFixed(1)}s-${(coreEndByte / PCM_BYTES_PER_SECOND).toFixed(1)}s]: ${error.message}`,
      );
    }

    const parsedSegments = this.extractSegments(
      result,
      track.speakerName,
      requestOffsetSeconds,
      false,
    );
    // Each block owns a non-overlapping core interval. Use utterance midpoints
    // to assign a boundary-crossing utterance to exactly one block.
    const coreSegments = parsedSegments.filter((segment) => {
      const midpoint = (segment.start + segment.end) / 2;
      return midpoint >= coreStartSeconds &&
        (midpoint < coreEndSeconds ||
          (coreEndByte === totalBytes && midpoint <= coreEndSeconds));
    });

    const checkpoint: ChunkCheckpoint = {
      version: 1,
      startByte: coreStartByte,
      endByte: coreEndByte,
      segments: coreSegments,
    };
    const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(checkpoint), 'utf8');
      fs.renameSync(temporaryPath, checkpointPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }

    console.log(
      `[Transcription] Checkpoint saved for ${track.speakerName}: ` +
      `${coreSegments.length} segment(s), bytes ${coreStartByte}-${coreEndByte}`,
    );
    return coreSegments;
  }

  /**
   * Legacy combined-WAV diarization path. Kept as a fallback/debug helper, but
   * the production batch pipeline should use transcribeUserTracks() so speaker
   * labels come from Discord rather than arbitrary Deepgram Speaker N labels.
   */
  async transcribeSession(wavPath: string): Promise<TranscriptResult> {
    const stats = fs.statSync(wavPath);
    if (stats.size < 1000) {
      console.log('[Transcription] Audio file too small, skipping');
      return { srt: '', text: 'No audio captured.', segments: [] };
    }

    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log(`[Transcription] Sending ${path.basename(wavPath)} to Deepgram Nova-3 (${sizeMB}MB)`);

    const params = new URLSearchParams({
  model: 'nova-3',
  language: 'multi',
  smart_format: 'true',
  diarize: 'true',
  utterances: 'true',
  punctuate: 'true',
  paragraphs: 'true',
});
	const campaignTerms = CampaignTermsService.load();
CampaignTermsService.applyToParams(params, campaignTerms);
    const result = await this.postToDeepgram(wavPath, stats.size, params, 'audio/wav');
    const segments = this.extractSegments(result, 'Speaker 0', 0, true);

    console.log(`[Transcription] Got ${segments.length} segments from Deepgram`);

    segments.sort((a, b) => a.start - b.start);

    return {
      srt: this.toSRT(segments),
      text: this.toPlainText(segments),
      segments,
    };
  }

  private async postToDeepgram(
    filePath: string,
    fileSize: number,
    params: URLSearchParams,
    contentType: string,
  ): Promise<any> {
    // Stream the file to avoid loading it all into memory.
    const fileStream = fs.createReadStream(filePath);

    const response = await fetch(
      `https://api.deepgram.com/v1/listen?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiKey}`,
          'Content-Type': contentType,
          'Content-Length': fileSize.toString(),
        },
        body: fileStream as any,
        // @ts-ignore - duplex needed for streaming body in Node
        duplex: 'half',
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Deepgram API error ${response.status}: ${errText}`);
    }

    return response.json();
  }


  private async postToDeepgramStream(
    audioStream: NodeJS.ReadableStream,
    fileSize: number,
    params: URLSearchParams,
    contentType: string,
  ): Promise<any> {
    try {
      const response = await fetch(
        `https://api.deepgram.com/v1/listen?${params.toString()}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${this.apiKey}`,
            'Content-Type': contentType,
            'Content-Length': fileSize.toString(),
          },
          body: audioStream as any,
          // @ts-ignore - duplex is required for a streaming Node request body.
          duplex: 'half',
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new DeepgramRequestError(response.status, errText);
      }

      return response.json();
    } catch (err) {
      try {
        (audioStream as any).destroy?.();
      } catch {}
      throw err;
    }
  }

  private extractSegments(
    result: any,
    speakerName: string,
    offsetSeconds: number,
    useDiarizedSpeakerLabels: boolean,
  ): Segment[] {
    const segments: Segment[] = [];

    // Prefer utterances: they have useful start/end boundaries. For per-user
    // transcription, ignore any speaker number and apply the known Discord name.
    if (result?.results?.utterances) {
      for (const utt of result.results.utterances) {
        const text = utt.transcript?.trim();
        if (!text) continue;
        const speakerNum = utt.speaker ?? 0;
        segments.push({
          speaker: useDiarizedSpeakerLabels ? `Speaker ${speakerNum}` : speakerName,
          start: (utt.start ?? 0) + offsetSeconds,
          end: (utt.end ?? utt.start ?? 0) + offsetSeconds,
          text,
        });
      }
    } else if (result?.results?.channels?.[0]?.alternatives?.[0]) {
      // Fallback: no utterances, use the full transcript for this track.
      const alt = result.results.channels[0].alternatives[0];
      const text = alt.transcript?.trim();
      if (text) {
        segments.push({
          speaker: speakerName,
          start: offsetSeconds,
          end: offsetSeconds + (result.metadata?.duration || 0),
          text,
        });
      }
    }

    return segments;
  }

  private toSRT(segments: Segment[]): string {
    return segments
      .map((seg, i) => {
        const startTs = this.formatSRTTime(seg.start);
        const endTs = this.formatSRTTime(seg.end);
        return `${i + 1}\n${startTs} --> ${endTs}\n[${seg.speaker}]: ${seg.text}\n`;
      })
      .join('\n');
  }

  private toPlainText(segments: Segment[]): string {
    let text = '';
    let lastSpeaker = '';

    for (const seg of segments) {
      if (seg.speaker !== lastSpeaker) {
        if (text) text += '\n';
        text += `\n[${seg.speaker}]:\n`;
        lastSpeaker = seg.speaker;
      }
      text += `${seg.text} `;
    }

    return text.trim();
  }

  private formatSRTTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }
}
