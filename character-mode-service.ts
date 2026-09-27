import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { Config } from '../src/config';

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
const MAX_BUTTON_LABEL = 80;
const MAX_COMPONENT_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;

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

  static getDmUserIds(): string[] {
    return [...Config.CHARACTER_DM_USER_IDS];
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
    const remainder = customId.slice(BUTTON_PREFIX.length);
    const separator = remainder.indexOf(':');
    if (separator <= 0) return null;
    return remainder.slice(0, separator);
  }

  static modeFromButton(customId: string): { mode: SpeakerMode; characterName: string | null } | null {
    if (!this.isModeButton(customId)) return null;
    const remainder = customId.slice(BUTTON_PREFIX.length);
    const separator = remainder.indexOf(':');
    if (separator <= 0) return null;

    const action = remainder.slice(separator + 1);
    if (action === 'dm') {
      return { mode: 'dm', characterName: null };
    }
    if (!action.startsWith('char:')) return null;

    const encodedName = action.slice('char:'.length);
    try {
      const characterName = decodeURIComponent(encodedName);
      return { mode: 'character', characterName };
    } catch {
      return null;
    }
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
  ): ActionRowBuilder<ButtonBuilder>[] {
    const buttons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId(BUTTON_PREFIX + voiceChannelId + ':dm')
        .setLabel('DM / Narrador')
        .setStyle(ButtonStyle.Secondary),
    ];

    for (const character of this.getCharacters()) {
      if (buttons.length >= MAX_COMPONENT_ROWS * MAX_BUTTONS_PER_ROW) break;
      const encoded = encodeURIComponent(character.name);
      const customId = BUTTON_PREFIX + voiceChannelId + ':char:' + encoded;
      if (customId.length > 100) continue;
      buttons.push(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(character.name.slice(0, MAX_BUTTON_LABEL))
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
}
