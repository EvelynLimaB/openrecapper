import fs from 'fs';
import os from 'os';
import path from 'path';
import { TranscriptionService, UserTrackInput } from '../src/services/transcription-service';

const BYTES_PER_SECOND = 48000 * 2 * 2;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ✅ ${message}`);
}

interface RecordedCall {
  url: string;
  bytes: number;
}

async function consumeBody(body: unknown): Promise<number> {
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    size += Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.byteLength(chunk);
  }
  return size;
}

function successfulResponse(callNumber: number, bytes: number): Response {
  return new Response(JSON.stringify({
    metadata: { duration: bytes / BYTES_PER_SECOND },
    results: {
      utterances: [{
        start: 0.3,
        end: 0.5,
        transcript: `mock-segment-${callNumber}`,
        speaker: 0,
      }],
      channels: [{
        alternatives: [{
          transcript: `mock-segment-${callNumber}`,
          words: [{
            word: `mock-segment-${callNumber}`,
            punctuated_word: `mock-segment-${callNumber}`,
            start: 0.2,
            end: 0.5,
          }],
        }],
      }],
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function testBlockSplittingAndCache(): Promise<void> {
  console.log('\n── Test: PCM is sent in bounded blocks and cached ──');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-chunks-'));
  const filePath = path.join(tmpDir, 'player-123.pcm');
  const progressDir = path.join(tmpDir, 'progress');
  fs.writeFileSync(filePath, Buffer.alloc(10 * BYTES_PER_SECOND));
  const sessionStart = 1_000_000;
  const track: UserTrackInput = {
    filePath,
    userId: 'player-123',
    speakerName: 'Kasane',
    startedAt: sessionStart + 25_000,
  };
  const calls: RecordedCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const bytes = await consumeBody(init?.body);
    calls.push({ url: String(input), bytes });
    return successfulResponse(calls.length, bytes);
  }) as typeof fetch;

  try {
    const service = new TranscriptionService('test-key', {
      chunkSeconds: 4,
      overlapSeconds: 0.25,
      minSplitSeconds: 1,
    });
    const first = await service.transcribeUserTracks([track], sessionStart, progressDir);

    assert(calls.length === 3, '10 seconds of PCM results in 3 block requests');
    assert(calls[0].bytes === 4.25 * BYTES_PER_SECOND, 'First block carries its core plus trailing overlap');
    assert(calls[1].bytes === 4.5 * BYTES_PER_SECOND, 'Middle block carries leading and trailing overlap');
    assert(calls[2].bytes === 2.25 * BYTES_PER_SECOND, 'Final block is clipped to end of track');
    assert(first.segments.length === 3, 'One owned segment is retained from each block');
    assert(first.segments.every((segment) => segment.speaker === 'Kasane'), 'Known Discord speaker label is preserved');
    assert(Math.abs(first.segments[0].start - 25.3) < 0.001, 'Track start offset is preserved in timestamps');
    assert(first.segments[0].start < first.segments[1].start && first.segments[1].start < first.segments[2].start, 'Segments are chronologically ordered');

    const countBeforeResume = calls.length;
    const second = await service.transcribeUserTracks([track], sessionStart, progressDir);
    assert(calls.length === countBeforeResume, 'Second run reuses all completed checkpoints without API calls');
    assert(second.srt === first.srt, 'Resumed output matches the first output');
    assert(calls.every((call) => call.url.includes('model=nova-3')), 'Nova-3 batch model parameter is retained');
    assert(calls.every((call) => call.url.includes('encoding=linear16') && call.url.includes('sample_rate=48000') && call.url.includes('channels=2')), 'PCM encoding parameters are retained');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testResumeAfterFailure(): Promise<void> {
  console.log('\n── Test: Failed block resumes without repeating completed blocks ──');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-resume-'));
  const filePath = path.join(tmpDir, 'player-456.pcm');
  const progressDir = path.join(tmpDir, 'progress');
  fs.writeFileSync(filePath, Buffer.alloc(6 * BYTES_PER_SECOND));
  const sessionStart = 2_000_000;
  const track: UserTrackInput = {
    filePath,
    userId: 'player-456',
    speakerName: 'Shiki',
    startedAt: sessionStart,
  };
  const calls: RecordedCall[] = [];
  const originalFetch = globalThis.fetch;
  let shouldFail = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const bytes = await consumeBody(init?.body);
    calls.push({ url: String(input), bytes });
    if (shouldFail && calls.length === 2) {
      return new Response(JSON.stringify({ err_code: 'TEST_FAILURE' }), { status: 503 });
    }
    return successfulResponse(calls.length, bytes);
  }) as typeof fetch;

  try {
    const service = new TranscriptionService('test-key', {
      chunkSeconds: 2,
      overlapSeconds: 0,
      minSplitSeconds: 1,
    });
    let firstFailed = false;
    try {
      await service.transcribeUserTracks([track], sessionStart, progressDir);
    } catch (err) {
      firstFailed = String(err).includes('503');
    }
    assert(firstFailed, 'Transient non-504 failure is reported instead of producing a false complete transcript');
    assert(calls.length === 2, 'Processing stops at the first failed block');
    shouldFail = false;

    const result = await service.transcribeUserTracks([track], sessionStart, progressDir);
    assert(calls.length === 4, 'Resume skips block one and requests only the failed and remaining blocks');
    assert(result.segments.length === 3, 'Resumed run returns segments for all three blocks');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function test504AdaptiveSplit(): Promise<void> {
  console.log('\n── Test: 504 causes recursive subdivision ──');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-504-'));
  const filePath = path.join(tmpDir, 'player-789.pcm');
  const progressDir = path.join(tmpDir, 'progress');
  fs.writeFileSync(filePath, Buffer.alloc(4 * BYTES_PER_SECOND));
  const sessionStart = 3_000_000;
  const track: UserTrackInput = {
    filePath,
    userId: 'player-789',
    speakerName: 'Conrad',
    startedAt: sessionStart,
  };
  const calls: RecordedCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const bytes = await consumeBody(init?.body);
    calls.push({ url: String(input), bytes });
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        err_code: 'Gateway Timeout',
        err_msg: 'Request timeout. Please try again later.',
      }), { status: 504 });
    }
    return successfulResponse(calls.length, bytes);
  }) as typeof fetch;

  try {
    const service = new TranscriptionService('test-key', {
      chunkSeconds: 4,
      overlapSeconds: 0.25,
      minSplitSeconds: 1,
    });
    const result = await service.transcribeUserTracks([track], sessionStart, progressDir);
    assert(calls.length === 3, 'Initial 504 block is retried as two smaller blocks');
    assert(result.segments.length === 2, 'Both smaller blocks contribute a segment');
    assert(result.segments.every((segment) => segment.speaker === 'Conrad'), 'Speaker attribution survives adaptive splitting');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testBlockSplittingAndCache();
  await testResumeAfterFailure();
  await test504AdaptiveSplit();
  console.log('\nAll chunked transcription tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
