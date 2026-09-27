import fs from 'fs';
import path from 'path';
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

export interface UserTrackInput {
  filePath: string;
  userId: string;
  speakerName: string;
  /** Absolute wall-clock timestamp (ms) when this user's PCM starts. */
  startedAt: number;
}

export class TranscriptionService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
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

    console.log(`[Transcription] Transcribing ${validTracks.length} per-user track(s) with Deepgram Nova-3`);

    // Sequential calls are gentler on Deepgram/rate limits and make logs easier
    // to follow. Correct attribution is more important than shaving seconds here.
    for (const track of validTracks) {
      const offsetSeconds = Math.max(0, (track.startedAt - sessionStartedAt) / 1000);
      const trackSegments = await this.transcribePcmTrack(track, offsetSeconds);
      segments.push(...trackSegments);
    }

    // Sort segments chronologically. When speakers overlap, keep a stable-ish
    // order by end time then speaker name to avoid nondeterministic output.
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

  private async transcribePcmTrack(track: UserTrackInput, offsetSeconds: number): Promise<Segment[]> {
    const stats = fs.statSync(track.filePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log(
      `[Transcription] Sending ${path.basename(track.filePath)} (${track.speakerName}) ` +
      `to Deepgram Nova-3 (${sizeMB}MB, offset=${offsetSeconds.toFixed(1)}s)`,
    );

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
const result = await this.postToDeepgram(track.filePath, stats.size, params, 'audio/raw');
    return this.extractSegments(result, track.speakerName, offsetSeconds, false);
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
