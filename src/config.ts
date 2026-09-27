import { config } from 'dotenv';
import path from 'path';

// Load .env from project root (ignored in production if not present)
config({ path: path.join(__dirname, '..', '.env') });

// Comma-separated bot tokens. tokens[0] is the "primary" (slash commands,
// delivery, member resolution — and it can record too). Additional tokens are
// voice-only recorder identities. Number of tokens = max concurrent
// recordings per server. Falls back to the legacy single DISCORD_TOKEN.
const tokens = (process.env.DISCORD_TOKENS || process.env.DISCORD_TOKEN || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const recordMeetingNames = (process.env.RECORD_MEETING_NAMES || 'UNNAMED-MEETING')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

if (recordMeetingNames.length === 0) {
  recordMeetingNames.push('UNNAMED-MEETING');
}

const characterDmUserIds = (process.env.CHARACTER_DM_USER_IDS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const characterDefinitionsRaw =
  process.env.CHARACTER_DEFINITIONS ||
  'Arsene:3498DB,Kasane:9B59B6,Mello:2ECC71,Lorenzo:E67E22';

const characterDefinitions = characterDefinitionsRaw
  .split(',')
  .map((entry) => {
    const [nameRaw, colorRaw] = entry.split(':', 2);
    const name = nameRaw?.trim() || '';
    const color = colorRaw?.trim().replace(/^#/, '') || '';

    if (!name || !/^[0-9A-Fa-f]{6}$/.test(color)) {
      return null;
    }

    return {
      name,
      color: `#${color.toUpperCase()}`,
    };
  })
  .filter(
    (entry): entry is { name: string; color: string } =>
      entry !== null,
  );

export const Config = {
  DISCORD_TOKENS: tokens,

  // Primary token — kept so existing single-token call sites
  // (register-commands.ts, index.ts) stay unchanged.
  DISCORD_TOKEN: tokens[0] ?? '',

  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID!,
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY!,

  // Display name used in health-check alerts and email subjects.
  BOT_NAME: process.env.BOT_NAME || 'OpenRecapper',

  // Meeting names offered by /record's name option. Date is appended automatically.
  RECORD_MEETING_NAMES: recordMeetingNames,

  RECORDINGS_DIR:
    process.env.RECORDINGS_DIR ||
    path.join(__dirname, '..', 'recordings'),

  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || '',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
  R2_BUCKET: process.env.R2_BUCKET || '',
  R2_ENDPOINT: process.env.R2_ENDPOINT || '',
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || '',

  // User to DM when a startup health check fails (optional).
  ALERT_DISCORD_USER_ID:
    process.env.ALERT_DISCORD_USER_ID || '',

  // AI summary + email are routed through a small companion "relay" HTTP
  // service that bridges to an LLM provider (for summaries) and an email
  // gateway. Summarization/email are skipped gracefully if RELAY_TOKEN is unset,
  // so the bot still records and transcribes without a relay configured.
  // See README “AI summaries & email (optional)” for the expected relay API.
  RELAY_URL:
    process.env.RELAY_URL ||
    'http://127.0.0.1:8787',

  RELAY_TOKEN:
    process.env.RELAY_TOKEN || '',

  // Gateway model used for summaries (cost-optimal default). Empty => relay default.
  SUMMARY_MODEL:
    process.env.SUMMARY_MODEL || '',

  // What the group reads/discusses — tunes the summary template wording.
  SUMMARY_GROUP_NAME:
    process.env.SUMMARY_GROUP_NAME || 'study group',

  // Where to email the summary + transcript links after each call (optional).
  SUMMARY_EMAIL_TO:
    process.env.SUMMARY_EMAIL_TO || '',

  // Number of days to keep raw audio files (.pcm, .wav) before auto-cleanup.
  // Transcripts and metadata are always preserved. Default: 7 days.
  RECORDING_RETENTION_DAYS: parseInt(
    process.env.RECORDING_RETENTION_DAYS || '7',
    10,
  ),

  // Minutes of silence (no opus packets from any user) before the bot
  // auto-leaves the voice channel.
  SILENCE_TIMEOUT_MINUTES: parseInt(
    process.env.SILENCE_TIMEOUT_MINUTES || '20',
    10,
  ),

  // Optional override for where standing-call schedules are persisted.
  // Defaults to ./data/schedules.json (managed via the /schedule command).
  SCHEDULES_FILE:
    process.env.SCHEDULES_FILE || '',

  // Optional override for where per-guild /record grants are persisted.
  // Defaults to ./data/record-permissions.json (managed via /record-access).
  RECORD_PERMISSIONS_FILE:
    process.env.RECORD_PERMISSIONS_FILE || '',

  SUMMARY_CHANNELS_FILE:
    process.env.SUMMARY_CHANNELS_FILE || '',

  // GitHub issue filing via the /openrecapper-issue command (optional).
  GITHUB_TOKEN:
    process.env.GITHUB_TOKEN || '',

  GITHUB_OWNER:
    process.env.GITHUB_OWNER || '',

  GITHUB_REPO:
    process.env.GITHUB_REPO || '',

  ISSUE_EMAIL_TO:
    process.env.ISSUE_EMAIL_TO || '',

  ISSUE_CC_USER_IDS:
    process.env.ISSUE_CC_USER_IDS || '',

  // Live DM character presentation.
  // Empty = feature disabled.
  CHARACTER_DM_USER_IDS:
    characterDmUserIds,

  CHARACTER_DEFINITIONS:
    characterDefinitions.length > 0
      ? characterDefinitions
      : [
          {
            name: 'Arsene',
            color: '#3498DB',
          },
          {
            name: 'Kasane',
            color: '#9B59B6',
          },
          {
            name: 'Mello',
            color: '#2ECC71',
          },
          {
            name: 'Lorenzo',
            color: '#E67E22',
          },
        ],
};

export function validateConfig() {
  const missing: string[] = [];

  if (Config.DISCORD_TOKENS.length === 0) {
    missing.push(
      'DISCORD_TOKENS (or DISCORD_TOKEN)',
    );
  }

  if (!Config.DISCORD_CLIENT_ID) {
    missing.push('DISCORD_CLIENT_ID');
  }

  if (!Config.DEEPGRAM_API_KEY) {
    missing.push('DEEPGRAM_API_KEY');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}`,
    );
  }
}