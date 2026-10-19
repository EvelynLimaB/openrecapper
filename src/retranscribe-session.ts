import fs from 'fs';
import path from 'path';
import { Config } from './config';
import { TranscriptionService, UserTrackInput } from './services/transcription-service';

interface RecoveryTrackMapping {
  speakerName: string;
  /** Seconds from the start of the Discord recording to this track's first PCM frame. */
  offsetSeconds: number;
}

interface RecoveryManifest {
  sessionStartedAt?: number;
  tracks: Record<string, RecoveryTrackMapping>;
}

function writeFileAtomically(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

function readRecoveryManifest(filePath: string): RecoveryManifest {
  // Windows PowerShell 5 may write UTF-8 JSON with a BOM.
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const value = JSON.parse(raw) as RecoveryManifest;
  if (!value || typeof value.tracks !== 'object' || !value.tracks) {
    throw new Error('Recovery map must contain a "tracks" object.');
  }
  return value;
}

async function main(): Promise<void> {
  const [sessionDirArgument, manifestArgument] = process.argv.slice(2);
  if (!sessionDirArgument || !manifestArgument) {
    throw new Error(
      'Usage: node dist/retranscribe-session.js <session-directory> <recovery-map.json>',
    );
  }

  const sessionDir = path.resolve(sessionDirArgument);
  const manifestPath = path.resolve(manifestArgument);
  if (!fs.statSync(sessionDir).isDirectory()) {
    throw new Error(`Session path is not a directory: ${sessionDir}`);
  }
  if (!Config.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is missing from the environment.');
  }

  const manifest = readRecoveryManifest(manifestPath);
  const folderTimestamp = Number(path.basename(sessionDir).split('_').pop());
  const sessionStartedAt = manifest.sessionStartedAt ?? folderTimestamp;
  if (!Number.isFinite(sessionStartedAt) || sessionStartedAt <= 0) {
    throw new Error(
      'Could not determine sessionStartedAt. Add it to the recovery map.',
    );
  }

  const pcmFiles = fs.readdirSync(sessionDir)
    .filter((name) => /^\d+\.pcm$/i.test(name))
    .map((name) => path.join(sessionDir, name))
    .sort();

  if (pcmFiles.length === 0) {
    throw new Error(`No per-user .pcm files found in ${sessionDir}`);
  }

  const tracks: UserTrackInput[] = pcmFiles.map((filePath) => {
    const userId = path.basename(filePath, '.pcm');
    const mapping = manifest.tracks[userId];
    if (!mapping || !mapping.speakerName?.trim()) {
      throw new Error(
        `Missing tracks["${userId}"].speakerName in recovery map ${manifestPath}`,
      );
    }
    if (
      !Number.isFinite(mapping.offsetSeconds) ||
      mapping.offsetSeconds < 0
    ) {
      throw new Error(
        `Invalid non-negative offsetSeconds for user ${userId}`,
      );
    }

    return {
      filePath,
      userId,
      speakerName: mapping.speakerName.trim(),
      startedAt: sessionStartedAt + mapping.offsetSeconds * 1000,
    };
  });

  console.log(`[Recovery] Session: ${sessionDir}`);
  console.log(`[Recovery] Start timestamp: ${new Date(sessionStartedAt).toISOString()}`);
  console.log(`[Recovery] Found ${tracks.length} participant PCM track(s)`);
  console.log('[Recovery] Original PCM files will not be modified.');

  const service = new TranscriptionService(Config.DEEPGRAM_API_KEY);
  const result = await service.transcribeUserTracks(
    tracks,
    sessionStartedAt,
    path.join(sessionDir, 'transcription-progress'),
  );

  const srtPath = path.join(sessionDir, 'transcript-recovered.srt');
  const textPath = path.join(sessionDir, 'transcript-recovered.txt');
  const metadataPath = path.join(sessionDir, 'transcript-recovered.json');
  writeFileAtomically(srtPath, result.srt);
  writeFileAtomically(textPath, result.text + '\n');
  writeFileAtomically(metadataPath, JSON.stringify({
    recoveredAt: new Date().toISOString(),
    sessionStartedAt: new Date(sessionStartedAt).toISOString(),
    participantCount: tracks.length,
    segmentCount: result.segments.length,
    transcriptFiles: {
      srt: path.basename(srtPath),
      text: path.basename(textPath),
    },
    tracks: tracks.map((track) => ({
      userId: track.userId,
      speakerName: track.speakerName,
      offsetSeconds: (track.startedAt - sessionStartedAt) / 1000,
      file: path.basename(track.filePath),
      sizeBytes: fs.statSync(track.filePath).size,
    })),
  }, null, 2) + '\n');

  console.log(`[Recovery] Completed: ${result.segments.length} segments.`);
  console.log(`[Recovery] SRT: ${srtPath}`);
  console.log(`[Recovery] Text: ${textPath}`);
  console.log(`[Recovery] Metadata: ${metadataPath}`);
}

main().catch((err) => {
  console.error('[Recovery] Transcription did not complete. Checkpoints are preserved for retry.');
  console.error(err);
  process.exitCode = 1;
});
