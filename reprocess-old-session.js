const fs = require('fs');
const path = require('path');

const { TranscriptionService } = require(
  './dist/services/transcription-service.js'
);

const sessionDir = process.argv[2];

if (!sessionDir) {
  console.error('Usage: node reprocess-old-session.js <sessionDir>');
  process.exit(1);
}

if (!fs.existsSync(sessionDir)) {
  console.error(`Session directory not found: ${sessionDir}`);
  process.exit(1);
}

async function main() {
  const metadataPath = path.join(sessionDir, 'metadata.json');

  let metadata = {};

  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(
      fs.readFileSync(metadataPath, 'utf8')
    );
  }

  const speakers = metadata.speakers || {};

  const pcmFiles = fs
    .readdirSync(sessionDir)
    .filter((file) => file.toLowerCase().endsWith('.pcm'))
    .sort();

  if (pcmFiles.length === 0) {
    throw new Error('No PCM tracks found.');
  }

  console.log(`Found ${pcmFiles.length} PCM track(s).`);

  const service = new TranscriptionService(
    process.env.DEEPGRAM_API_KEY
  );

  const allSegments = [];

  for (const file of pcmFiles) {
    const userId = path.basename(file, '.pcm');
    const speakerName = speakers[userId] || userId;
    const filePath = path.join(sessionDir, file);

    console.log(`Transcribing ${speakerName} (${file})...`);

    const track = {
      filePath,
      userId,
      speakerName,
      startedAt: 0
    };

    const segments = await service.transcribePcmTrack(track, 0);

    console.log(
      `Received ${segments.length} segment(s) for ${speakerName}.`
    );

    for (const segment of segments) {
      allSegments.push({
        speaker: segment.speaker,
        start: segment.start,
        end: segment.end,
        text: segment.text
      });
    }
  }

  allSegments.sort((a, b) => a.start - b.start);

  const text = allSegments
    .map(
      (segment) =>
        `[${segment.speaker}] ${segment.text}`
    )
    .join('\n');

  const outputPath = path.join(
    sessionDir,
    'reprocessed-transcript.txt'
  );

  fs.writeFileSync(
    outputPath,
    text + '\n',
    'utf8'
  );

  console.log('');
  console.log('========================================');
  console.log('REPROCESSING COMPLETE');
  console.log('========================================');
  console.log(`Segments: ${allSegments.length}`);
  console.log(`Output: ${outputPath}`);
}

main().catch((error) => {
  console.error('');
  console.error('REPROCESSING FAILED');
  console.error(error);
  process.exit(1);
});
