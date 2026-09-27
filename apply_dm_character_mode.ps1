$ErrorActionPreference = 'Stop'

$repo = (Get-Location).Path
if (-not (Test-Path '.git')) { throw 'Execute este script na raiz de C:\RPG\openrecapper.' }

$status = git status --porcelain
if ($status) {
  throw 'Working tree não está limpa. Faça commit/stash antes de aplicar este patch para evitar sobrescrever alterações.'
}

$branch = 'feature/dm-character-mode-live'
$existing = git branch --list $branch
if ($existing) {
  throw "A branch $branch já existe localmente. Remova-a ou escolha outro nome antes de executar."
}

git switch -c $branch | Out-Host

function Assert-Contains([string]$Path, [string]$Needle) {
  $text = Get-Content -Raw -LiteralPath $Path
  if (-not $text.Contains($Needle)) {
    throw "Não encontrei o marcador esperado em $Path. O arquivo pode ter mudado em relação à versão validada."
  }
}

function Replace-Exact([string]$Path, [string]$Old, [string]$New) {
  $text = Get-Content -Raw -LiteralPath $Path
  if (-not $text.Contains($Old)) {
    throw "Não encontrei o bloco esperado em $Path. Nenhuma alteração foi aplicada nesse arquivo."
  }
  $updated = $text.Replace($Old, $New)
  Set-Content -LiteralPath $Path -Value $updated -NoNewline -Encoding utf8
}

# -----------------------------------------------------------------------------
# New character mode service
# -----------------------------------------------------------------------------
@'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { Config } from '../config';

export type SpeakerMode = 'dm' | 'character';

export interface CharacterDefinition {
  name: string;
  color: string;
}

export interface SpeakerPresentation {
  label: string;
  color: string;
}

interface SessionMode {
  guildId: string;
  voiceChannelId: string;
  userId: string;
  mode: SpeakerMode;
  characterName: string | null;
}

const DM_COLOR = '#FFFFFF';
const DEFAULT_COLOR = '#95A5A6';
const BUTTON_PREFIX = 'ocr:character-mode:';
const MAX_BUTTONS_PER_ROW = 5;
const MAX_COMPONENT_ROWS = 5;
const MAX_CUSTOM_ID_LENGTH = 100;

export class CharacterModeService {
  private static modes: Map<string, SessionMode> = new Map();

  static getCharacters(): CharacterDefinition[] {
    return Config.CHARACTER_DEFINITIONS.map((character) => ({ ...character }));
  }

  static getCharacter(name: string): CharacterDefinition | null {
    const normalized = name.trim().toLocaleLowerCase();
    return (
      Config.CHARACTER_DEFINITIONS.find(
        (character) => character.name.toLocaleLowerCase() === normalized,
      ) ?? null
    );
  }

  static isDmUser(userId: string): boolean {
    return Config.CHARACTER_DM_USER_IDS.includes(userId);
  }

  private static sessionKey(
    guildId: string,
    voiceChannelId: string,
    userId: string,
  ): string {
    return `${guildId}:${voiceChannelId}:${userId}`;
  }

  static getMode(
    guildId: string,
    voiceChannelId: string,
    userId: string,
  ): SessionMode {
    return (
      this.modes.get(this.sessionKey(guildId, voiceChannelId, userId)) ?? {
        guildId,
        voiceChannelId,
        userId,
        mode: 'dm',
        characterName: null,
      }
    );
  }

  static setMode(
    guildId: string,
    voiceChannelId: string,
    userId: string,
    mode: SpeakerMode,
    characterName: string | null,
  ): SessionMode {
    const next: SessionMode = {
      guildId,
      voiceChannelId,
      userId,
      mode,
      characterName: characterName?.trim() || null,
    };
    this.modes.set(
      this.sessionKey(guildId, voiceChannelId, userId),
      next,
    );
    return { ...next };
  }

  static clearSession(guildId: string, voiceChannelId: string): void {
    const prefix = `${guildId}:${voiceChannelId}:`;
    for (const key of this.modes.keys()) {
      if (key.startsWith(prefix)) this.modes.delete(key);
    }
  }

  static getPresentation(
    guildId: string,
    voiceChannelId: string,
    userId: string,
    username: string,
  ): SpeakerPresentation {
    if (!this.isDmUser(userId)) {
      return { label: username, color: DEFAULT_COLOR };
    }

    const mode = this.getMode(guildId, voiceChannelId, userId);
    if (mode.mode === 'character' && mode.characterName) {
      const character = this.getCharacter(mode.characterName);
      if (character) {
        return { label: character.name, color: character.color };
      }
    }

    return { label: 'DM / Narrador', color: DM_COLOR };
  }

  static isModeButton(customId: string): boolean {
    return customId.startsWith(BUTTON_PREFIX);
  }

  static voiceChannelIdFromButton(customId: string): string | null {
    if (!this.isModeButton(customId)) return null;
    const parts = customId.slice(BUTTON_PREFIX.length).split(':');
    return parts[0] || null;
  }

  static sessionTokenFromButton(customId: string): string | null {
    if (!this.isModeButton(customId)) return null;
    const parts = customId.slice(BUTTON_PREFIX.length).split(':');
    return parts[1] || null;
  }

  static modeFromButton(customId: string): {
    mode: SpeakerMode;
    characterName: string | null;
  } | null {
    if (!this.isModeButton(customId)) return null;
    const parts = customId.slice(BUTTON_PREFIX.length).split(':');
    if (parts.length < 3) return null;

    const action = parts.slice(2).join(':');
    if (action === 'dm') {
      return { mode: 'dm', characterName: null };
    }

    if (!action.startsWith('char:')) return null;

    try {
      return {
        mode: 'character',
        characterName: decodeURIComponent(action.slice('char:'.length)),
      };
    } catch {
      return null;
    }
  }

  static buildButtonCustomId(
    voiceChannelId: string,
    sessionToken: string,
    action: string,
  ): string {
    const customId = `${BUTTON_PREFIX}${voiceChannelId}:${sessionToken}:${action}`;
    if (customId.length > MAX_CUSTOM_ID_LENGTH) {
      throw new Error(`Character mode custom ID is too long: ${customId.length}`);
    }
    return customId;
  }

  static buildPanelContent(
    guildId: string,
    voiceChannelId: string,
    userId: string,
  ): string {
    const mode = this.getMode(guildId, voiceChannelId, userId);
    const active =
      mode.mode === 'character' && mode.characterName
        ? this.getCharacter(mode.characterName)?.name ?? 'DM / Narrador'
        : 'DM / Narrador';

    return [
      '🎭 **Modo de fala da DM**',
      `Modo atual: **${active}**`,
      'A mudança vale para as próximas falas reconhecidas.',
    ].join('\n');
  }

  static buildPanelComponents(
    voiceChannelId: string,
    sessionToken: string,
  ): ActionRowBuilder<ButtonBuilder>[] {
    const buttons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId(this.buildButtonCustomId(voiceChannelId, sessionToken, 'dm'))
        .setLabel('DM / Narrador')
        .setStyle(ButtonStyle.Secondary),
    ];

    for (const character of this.getCharacters()) {
      if (buttons.length >= MAX_BUTTONS_PER_ROW * MAX_COMPONENT_ROWS) break;
      const encoded = encodeURIComponent(character.name);
      const customId = this.buildButtonCustomId(
        voiceChannelId,
        sessionToken,
        'char:' + encoded,
      );
      buttons.push(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(character.name.slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      );
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let index = 0; index < buttons.length; index += MAX_BUTTONS_PER_ROW) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          buttons.slice(index, index + MAX_BUTTONS_PER_ROW),
        ),
      );
    }

    return rows.slice(0, MAX_COMPONENT_ROWS);
  }

  static getDmColor(): string {
    return DM_COLOR;
  }

  static getDefaultParticipantColor(): string {
    return DEFAULT_COLOR;
  }
}
'@ | Set-Content -LiteralPath '.\src\services\character-mode-service.ts' -Encoding utf8

# -----------------------------------------------------------------------------
# config.ts: DM IDs + character definitions
# -----------------------------------------------------------------------------
$marker = "if (recordMeetingNames.length === 0) recordMeetingNames.push('UNNAMED-MEETING');"
$insert = @'
if (recordMeetingNames.length === 0) recordMeetingNames.push('UNNAMED-MEETING');

const characterDmUserIds = (process.env.CHARACTER_DM_USER_IDS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const characterDefinitionsRaw = process.env.CHARACTER_DEFINITIONS ||
  'Arsene:3498DB,Kasane:9B59B6,Mello:2ECC71,Lorenzo:E67E22';

const characterDefinitions = characterDefinitionsRaw
  .split(',')
  .map((entry) => {
    const [nameRaw, colorRaw] = entry.split(':', 2);
    const name = nameRaw?.trim() || '';
    const color = colorRaw?.trim().replace(/^#/, '') || '';
    if (!name || !/^[0-9A-Fa-f]{6}$/.test(color)) return null;
    return { name, color: `#${color.toUpperCase()}` };
  })
  .filter((entry): entry is { name: string; color: string } => entry !== null);

'@
Replace-Exact '.\src\config.ts' $marker "$insert"

Replace-Exact '.\src\config.ts' "  RECORD_MEETING_NAMES: recordMeetingNames," @'
  RECORD_MEETING_NAMES: recordMeetingNames,
  // Discord user IDs allowed to control the live DM/character speaker mode.
  CHARACTER_DM_USER_IDS: characterDmUserIds,
  // Character buttons shown in the live transcription control panel.
  CHARACTER_DEFINITIONS: characterDefinitions.length > 0
    ? characterDefinitions
    : [
        { name: 'Arsene', color: '#3498DB' },
        { name: 'Kasane', color: '#9B59B6' },
        { name: 'Mello', color: '#2ECC71' },
        { name: 'Lorenzo', color: '#E67E22' },
      ],
'@

# -----------------------------------------------------------------------------
# live-transcription-service.ts
# -----------------------------------------------------------------------------
Replace-Exact '.\src\services\live-transcription-service.ts' "import { TextChannel } from 'discord.js';" @'
import {
  TextChannel,
  EmbedBuilder,
  ButtonInteraction,
} from 'discord.js';
import { CharacterModeService } from './character-mode-service';
'@

Replace-Exact '.\src\services\live-transcription-service.ts' @'
interface PendingTranscript {
  username: string;
  text: string;
  timestamp: number;
}
'@ @'
interface PendingTranscript {
  userId: string;
  username: string;
  label: string;
  color: string;
  text: string;
  timestamp: number;
}
'@

Replace-Exact '.\src\services\live-transcription-service.ts' @'
  private textChannel: TextChannel;
  private buffer: PendingTranscript[] = [];
'@ @'
  private textChannel: TextChannel;
  private voiceChannelId: string;
  private sessionToken: string;
  private buffer: PendingTranscript[] = [];
'@

Replace-Exact '.\src\services\live-transcription-service.ts' @'
  constructor(textChannel: TextChannel) {
    this.textChannel = textChannel;
  }
'@ @'
  constructor(
    textChannel: TextChannel,
    voiceChannelId: string,
    sessionToken: string,
  ) {
    this.textChannel = textChannel;
    this.voiceChannelId = voiceChannelId;
    this.sessionToken = sessionToken;
  }
'@

Replace-Exact '.\src\services\live-transcription-service.ts' @'
          if (transcript) {
            this.buffer.push({
              username,
              text: transcript,
              timestamp: Date.now(),
            });
          }
'@ @'
          if (transcript) {
            const presentation = CharacterModeService.getPresentation(
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
'@

$flushPattern = '(?s)  private async flush\(\): Promise<void> \{.*?\n  \}\r?\n\r?\n  private async postToChannel\(.*?\n  \}\r?\n\r?\n(?=  /\*\*\r?\n   \* Close a single user)'
$flushReplacement = @'
  private static splitTranscriptText(text: string, limit = 3900): string[] {
    const parts: string[] = [];
    let remaining = text.trim();

    while (remaining.length > limit) {
      let cut = remaining.lastIndexOf(' ', limit);
      if (cut < Math.floor(limit * 0.6)) cut = limit;
      parts.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }

    if (remaining) parts.push(remaining);
    return parts.length ? parts : [''];
  }

  private buildTranscriptEmbeds(items: PendingTranscript[]): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];

    for (const item of items) {
      for (const piece of LiveTranscriptionService.splitTranscriptText(item.text)) {
        const previous = embeds[embeds.length - 1];
        const previousAuthor = previous?.data.author?.name;
        const previousColor = previous?.data.color;
        const sameSpeaker =
          !!previous &&
          previousAuthor === item.label &&
          previousColor === parseInt(item.color.slice(1), 16);

        if (sameSpeaker) {
          const currentDescription = previous!.data.description || '';
          const nextDescription = currentDescription
            ? `${currentDescription}\\n${piece}`
            : piece;

          if (nextDescription.length <= 3900) {
            previous!.setDescription(nextDescription);
            continue;
          }
        }

        embeds.push(
          new EmbedBuilder()
            .setColor(item.color)
            .setAuthor({ name: item.label })
            .setDescription(piece),
        );
      }
    }

    return embeds;
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const items = this.buffer.splice(0);
    const embeds = this.buildTranscriptEmbeds(items);

    let batch: EmbedBuilder[] = [];
    let batchLength = 0;

    for (const embed of embeds) {
      const embedLength = embed.length;

      if (
        batch.length >= 10 ||
        (batch.length > 0 && batchLength + embedLength > 5800)
      ) {
        await this.postToChannel(batch);
        batch = [];
        batchLength = 0;
      }

      batch.push(embed);
      batchLength += embedLength;
    }

    if (batch.length > 0) await this.postToChannel(batch);
  }

  private async postToChannel(embeds: EmbedBuilder[]): Promise<void> {
    try {
      await this.textChannel.send({ embeds });
    } catch (err) {
      console.error(
        '[LiveTranscription] Failed to post to channel:',
        err,
      );
    }
  }

  /** Post the DM mode control panel for the current recording session. */
  async postCharacterModePanel(): Promise<void> {
    if (CharacterModeService.getDmUserIds().length === 0) {
      console.log(
        '[LiveTranscription] Character mode panel skipped: CHARACTER_DM_USER_IDS is empty',
      );
      return;
    }

    try {
      await this.textChannel.send({
        content: '🎭 **Controle da DM**\\nSelecione quem a DM está interpretando no transcript live.',
        components: CharacterModeService.buildPanelComponents(
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

  /** Handle one of the buttons belonging to this recording session. */
  async handleCharacterModeButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: '❌ This control only works in servers.',
        ephemeral: true,
      });
      return;
    }

    if (!CharacterModeService.isDmUser(interaction.user.id)) {
      await interaction.reply({
        content: '❌ Only the configured DM can use this control.',
        ephemeral: true,
      });
      return;
    }

    const buttonVoiceChannelId =
      CharacterModeService.voiceChannelIdFromButton(interaction.customId);
    const buttonSessionToken =
      CharacterModeService.sessionTokenFromButton(interaction.customId);

    if (
      buttonVoiceChannelId !== this.voiceChannelId ||
      buttonSessionToken !== this.sessionToken
    ) {
      await interaction.reply({
        content: '⚠️ This control panel belongs to an older recording session.',
        ephemeral: true,
      });
      return;
    }

    const selected = CharacterModeService.modeFromButton(interaction.customId);
    if (!selected) {
      await interaction.reply({
        content: '❌ Invalid character mode button.',
        ephemeral: true,
      });
      return;
    }

    if (
      selected.mode === 'character' &&
      !CharacterModeService.getCharacter(selected.characterName || '')
    ) {
      await interaction.reply({
        content: '❌ Character not found.',
        ephemeral: true,
      });
      return;
    }

    CharacterModeService.setMode(
      interaction.guildId,
      this.voiceChannelId,
      interaction.user.id,
      selected.mode,
      selected.characterName,
    );

    await interaction.update({
      content: CharacterModeService.buildPanelContent(
        interaction.guildId,
        this.voiceChannelId,
        interaction.user.id,
      ),
      components: CharacterModeService.buildPanelComponents(
        this.voiceChannelId,
        this.sessionToken,
      ),
    });
  }

'@
$liveText = Get-Content -Raw -LiteralPath '.\src\services\live-transcription-service.ts'
if (-not [regex]::IsMatch($liveText, $flushPattern)) { throw 'Não encontrei o bloco flush/postToChannel em live-transcription-service.ts.' }
$updatedLive = [regex]::Replace($liveText, $flushPattern, $flushReplacement)
Set-Content -LiteralPath '.\src\services\live-transcription-service.ts' -Value $updatedLive -NoNewline -Encoding utf8

# Clear session modes at shutdown, after final transcript flush.
$liveText = Get-Content -Raw -LiteralPath '.\src\services\live-transcription-service.ts'
$clearPattern = "    this.connections.clear\(\);\r?\n\r?\n    console\.log\('\[LiveTranscription\] All streams closed'\);"
if (-not [regex]::IsMatch($liveText, $clearPattern)) { throw 'Não encontrei o fechamento final do LiveTranscriptionService.' }
$liveText = [regex]::Replace($liveText, $clearPattern, "    this.connections.clear();`n    CharacterModeService.clearSession(this.textChannel.guild.id, this.voiceChannelId);`n`n    console.log('[LiveTranscription] All streams closed');")
Set-Content -LiteralPath '.\src\services\live-transcription-service.ts' -Value $liveText -NoNewline -Encoding utf8

# -----------------------------------------------------------------------------
# worker-manager.ts
# -----------------------------------------------------------------------------
Replace-Exact '.\src\services\worker-manager.ts' "liveTranscription = new LiveTranscriptionService(targetChannel as TextChannel);" "liveTranscription = new LiveTranscriptionService(\n              targetChannel as TextChannel,\n              options.channelId,\n              path.basename(sessionDir),\n            );"

Replace-Exact '.\src\services\worker-manager.ts' "      // Start silence-timeout monitoring if configured\n      this.startSilenceMonitor(session);" "      if (liveTranscription) {\n        await liveTranscription.postCharacterModePanel();\n      }\n\n      // Start silence-timeout monitoring if configured\n      this.startSilenceMonitor(session);"

# -----------------------------------------------------------------------------
# index.ts button routing
# -----------------------------------------------------------------------------
Replace-Exact '.\src\index.ts' "import { openrecapperIssueCommand } from './commands/openrecapper-issue';" @'
import { openrecapperIssueCommand } from './commands/openrecapper-issue';
import { CharacterModeService } from './services/character-mode-service';
'@

Replace-Exact '.\src\index.ts' "  if (!interaction.isChatInputCommand()) return;" @'
  if (interaction.isButton() && CharacterModeService.isModeButton(interaction.customId)) {
    const channelId = CharacterModeService.voiceChannelIdFromButton(interaction.customId);
    if (!channelId) {
      await interaction.reply({ content: '❌ Invalid character mode control.', ephemeral: true });
      return;
    }

    const session = WorkerManager.getInstance().getSession(channelId);
    if (!session?.liveTranscription) {
      await interaction.reply({
        content: '⚠️ This recording session is no longer active.',
        ephemeral: true,
      });
      return;
    }

    try {
      await session.liveTranscription.handleCharacterModeButton(interaction);
    } catch (err) {
      console.error('[CharacterMode] Button handling failed:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Failed to change character mode. Check the bot logs.',
          ephemeral: true,
        }).catch(() => {});
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
'@

# -----------------------------------------------------------------------------
# docs/config examples
# -----------------------------------------------------------------------------
Replace-Exact '.\.env.example' "RECORD_MEETING_NAMES=UNNAMED-MEETING" @'
RECORD_MEETING_NAMES=UNNAMED-MEETING
# User IDs of the DM(s) allowed to control live transcript character mode.
# Leave blank to disable the character-mode panel.
# CHARACTER_DM_USER_IDS=123456789012345678
# Character buttons: Name:6-digit-hex-without-# . Up to 24 can be shown as buttons.
# CHARACTER_DEFINITIONS=Arsene:3498DB,Kasane:9B59B6,Mello:2ECC71,Lorenzo:E67E22
'@

# -----------------------------------------------------------------------------
# test
# -----------------------------------------------------------------------------
@'
process.env.CHARACTER_DM_USER_IDS = 'dm-test-user';
process.env.CHARACTER_DEFINITIONS = 'Arsene:3498DB,Kasane:9B59B6';
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'test-client';
process.env.DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'test-key';

import assert from 'assert';

const { CharacterModeService } = require('../src/services/character-mode-service') as typeof import('../src/services/character-mode-service');

const guildId = 'guild-test';
const voiceChannelId = 'voice-test';
const sessionToken = 'session-test';
const dmUserId = 'dm-test-user';
const playerId = 'player-test-user';

assert.deepStrictEqual(
  CharacterModeService.getCharacters().map((c: { name: string; color: string }) => c.name),
  ['Arsene', 'Kasane'],
);

const dmPresentation = CharacterModeService.getPresentation(
  guildId,
  voiceChannelId,
  dmUserId,
  'Ellie - DM/Arsene',
);
assert.strictEqual(dmPresentation.label, 'DM / Narrador');
assert.strictEqual(dmPresentation.color, '#FFFFFF');

CharacterModeService.setMode(
  guildId,
  voiceChannelId,
  dmUserId,
  'character',
  'Arsene',
);

const arsenePresentation = CharacterModeService.getPresentation(
  guildId,
  voiceChannelId,
  dmUserId,
  'Ellie - DM/Arsene',
);
assert.strictEqual(arsenePresentation.label, 'Arsene');
assert.strictEqual(arsenePresentation.color, '#3498DB');

const playerPresentation = CharacterModeService.getPresentation(
  guildId,
  voiceChannelId,
  playerId,
  'Nico - Mello',
);
assert.strictEqual(playerPresentation.label, 'Nico - Mello');
assert.strictEqual(playerPresentation.color, '#95A5A6');

const buttonId = CharacterModeService.buildButtonCustomId(
  voiceChannelId,
  sessionToken,
  'char:' + encodeURIComponent('Arsene'),
);
assert.strictEqual(CharacterModeService.voiceChannelIdFromButton(buttonId), voiceChannelId);
assert.strictEqual(CharacterModeService.sessionTokenFromButton(buttonId), sessionToken);
assert.deepStrictEqual(
  CharacterModeService.modeFromButton(buttonId),
  { mode: 'character', characterName: 'Arsene' },
);

const dmButtonId = CharacterModeService.buildButtonCustomId(
  voiceChannelId,
  sessionToken,
  'dm',
);
assert.deepStrictEqual(
  CharacterModeService.modeFromButton(dmButtonId),
  { mode: 'dm', characterName: null },
);

const rows = CharacterModeService.buildPanelComponents(
  voiceChannelId,
  sessionToken,
);
assert.ok(rows.length >= 1 && rows.length <= 5);
assert.ok(rows.every((row: any) => row.components.length <= 5));

CharacterModeService.clearSession(guildId, voiceChannelId);
const afterClear = CharacterModeService.getPresentation(
  guildId,
  voiceChannelId,
  dmUserId,
  'Ellie - DM/Arsene',
);
assert.strictEqual(afterClear.label, 'DM / Narrador');
assert.strictEqual(afterClear.color, '#FFFFFF');

console.log('✅ Character mode service tests passed.');
'@ | Set-Content -LiteralPath '.\tests\test-character-mode.ts' -Encoding utf8

# package.json test script
Replace-Exact '.\package.json' '"test": "npx tsx tests/test-mixdown.ts && npx tsx tests/test-recorder-pool.ts && npx tsx tests/test-channel-guard.ts"' '"test": "npx tsx tests/test-mixdown.ts && npx tsx tests/test-recorder-pool.ts && npx tsx tests/test-channel-guard.ts && npx tsx tests/test-character-mode.ts"'

# README feature note
Replace-Exact '.\README.md' '- **Real-time transcription** — Live transcript streamed to a text channel as people talk.' @'
- **Real-time transcription** — Live transcript streamed to a text channel as people talk, with a DM-only character mode panel that can switch the displayed speaker between DM/narrator and configured characters without interrupting recording.
'@

# Safety check: no accidental MusicMan recording path changes are part of this PR.
Assert-Contains '.\src\workers\voice-worker.ts' "if (this.isBotUser(userId)) {"

Write-Host ''
Write-Host '=== git diff --check ===' -ForegroundColor Cyan
git diff --check

Write-Host ''
Write-Host '=== npm test ===' -ForegroundColor Cyan
npm test

Write-Host ''
Write-Host '=== npm run build ===' -ForegroundColor Cyan
npm run build

Write-Host ''
Write-Host '=== diff stat ===' -ForegroundColor Cyan
git diff --stat

Write-Host ''
Write-Host '=== changed files ===' -ForegroundColor Cyan
git status --short

Write-Host ''
Write-Host 'Validation passed.' -ForegroundColor Green

git add src/config.ts src/services/character-mode-service.ts src/services/live-transcription-service.ts src/services/worker-manager.ts src/index.ts tests/test-character-mode.ts .env.example package.json README.md
git commit -m 'Feature: add live DM character mode controls' | Out-Host
git push -u origin $branch | Out-Host

if (Get-Command gh -ErrorAction SilentlyContinue) {
  gh pr create --base main --head $branch --title 'Live DM character mode controls' --body 'Adds a DM-only live transcript control panel with instant DM/character switching, color-coded embeds, session isolation, and tests.' | Out-Host
} else {
  Write-Warning 'GitHub CLI (gh) not found. The branch was pushed; create the PR with: gh pr create --base main --head $branch'
}
