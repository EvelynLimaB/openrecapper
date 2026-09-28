import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { Config } from '../config';

export type SpeakerMode =
  | 'dm'
  | 'character'
  | 'npc';

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

export type PlayerCharacterAssignmentResult =
  | {
      ok: true;
      character: CharacterDefinition | null;
    }
  | {
      ok: false;
      reason: 'invalid' | 'reserved';
      character: CharacterDefinition | null;
      conflictUserId: string | null;
    };

const DM_COLOR = '#FFFFFF';
const DEFAULT_COLOR = '#95A5A6';
const NPC_NAME = 'npc';
const PLAYER_NONE_VALUE = 'none';

const BUTTON_PREFIX = 'ocr:character-mode:';
const MAX_BUTTONS_PER_ROW = 5;
const MAX_COMPONENT_ROWS = 5;
const MAX_CUSTOM_ID_LENGTH = 100;
const MAX_SELECT_OPTIONS = 25;

export class CharacterModeService {
  private static modes = new Map<string, SessionMode>();
  private static playerCharacters = new Map<string, string>();

  static isEnabled(): boolean {
    return Config.CHARACTER_DM_USER_IDS.length > 0;
  }

  static getDmUserIds(): string[] {
    return [...Config.CHARACTER_DM_USER_IDS];
  }

  static getCharacters(): CharacterDefinition[] {
    return Config.CHARACTER_DEFINITIONS.map((character) => ({
      ...character,
    }));
  }

  static getPlayerCharacters(): CharacterDefinition[] {
    return this.getCharacters().filter(
      (character) =>
        character.name.trim().toLocaleLowerCase() !== NPC_NAME,
    );
  }

  static getCharacter(name: string): CharacterDefinition | null {
    const normalized = name.trim().toLocaleLowerCase();

    return (
      Config.CHARACTER_DEFINITIONS.find(
        (character) =>
          character.name.trim().toLocaleLowerCase() === normalized,
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

  private static sessionPrefix(
    guildId: string,
    voiceChannelId: string,
  ): string {
    return `${guildId}:${voiceChannelId}:`;
  }

  static getMode(
    guildId: string,
    voiceChannelId: string,
    userId: string,
  ): SessionMode {
    return (
      this.modes.get(
        this.sessionKey(guildId, voiceChannelId, userId),
      ) ?? {
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

  static getPlayerCharacter(
    guildId: string,
    voiceChannelId: string,
    userId: string,
  ): CharacterDefinition | null {
    const assignedName = this.playerCharacters.get(
      this.sessionKey(guildId, voiceChannelId, userId),
    );

    if (!assignedName) {
      return null;
    }

    return this.getCharacter(assignedName);
  }

  static getPlayerCharacterUserId(
    guildId: string,
    voiceChannelId: string,
    characterName: string,
  ): string | null {
    const normalized = characterName.trim().toLocaleLowerCase();
    const prefix = this.sessionPrefix(guildId, voiceChannelId);

    for (const [key, assignedName] of this.playerCharacters) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      if (
        assignedName.trim().toLocaleLowerCase() === normalized
      ) {
        return key.slice(prefix.length);
      }
    }

    return null;
  }

  static getAvailablePlayerCharacters(
    guildId: string,
    voiceChannelId: string,
    userId: string,
  ): CharacterDefinition[] {
    return this.getPlayerCharacters().filter((character) => {
      const owner = this.getPlayerCharacterUserId(
        guildId,
        voiceChannelId,
        character.name,
      );

      return !owner || owner === userId;
    });
  }

  static assignPlayerCharacter(
    guildId: string,
    voiceChannelId: string,
    userId: string,
    characterName: string | null,
  ): PlayerCharacterAssignmentResult {
    const key = this.sessionKey(
      guildId,
      voiceChannelId,
      userId,
    );

    if (characterName === null) {
      this.playerCharacters.delete(key);

      return {
        ok: true,
        character: null,
      };
    }

    const trimmed = characterName.trim();

    if (
      !trimmed ||
      trimmed.toLocaleLowerCase() === PLAYER_NONE_VALUE
    ) {
      this.playerCharacters.delete(key);

      return {
        ok: true,
        character: null,
      };
    }

    const character = this.getCharacter(trimmed);

    if (
      !character ||
      character.name.trim().toLocaleLowerCase() === NPC_NAME
    ) {
      return {
        ok: false,
        reason: 'invalid',
        character: null,
        conflictUserId: null,
      };
    }

    const owner = this.getPlayerCharacterUserId(
      guildId,
      voiceChannelId,
      character.name,
    );

    if (owner && owner !== userId) {
      return {
        ok: false,
        reason: 'reserved',
        character,
        conflictUserId: owner,
      };
    }

    this.playerCharacters.set(key, character.name);

    return {
      ok: true,
      character,
    };
  }

  static clearSession(
    guildId: string,
    voiceChannelId: string,
  ): void {
    const prefix = this.sessionPrefix(
      guildId,
      voiceChannelId,
    );

    for (const key of this.modes.keys()) {
      if (key.startsWith(prefix)) {
        this.modes.delete(key);
      }
    }

    for (const key of this.playerCharacters.keys()) {
      if (key.startsWith(prefix)) {
        this.playerCharacters.delete(key);
      }
    }
  }

  static buildPresentationMap(
    guildId: string,
    voiceChannelId: string,
    users: Map<string, string>,
  ): Map<string, SpeakerPresentation> {
    const presentations = new Map<string, SpeakerPresentation>();

    for (const [userId, username] of users) {
      presentations.set(
        userId,
        this.getPresentation(
          guildId,
          voiceChannelId,
          userId,
          username,
        ),
      );
    }

    return presentations;
  }

  static getPresentation(
    guildId: string,
    voiceChannelId: string,
    userId: string,
    username: string,
  ): SpeakerPresentation {
    if (this.isDmUser(userId)) {
      const mode = this.getMode(
        guildId,
        voiceChannelId,
        userId,
      );

      if (
        mode.mode === 'character' &&
        mode.characterName
      ) {
        const character = this.getCharacter(
          mode.characterName,
        );

        if (character) {
          return {
            label: character.name,
            color: character.color,
          };
        }
      }

      if (mode.mode === 'npc') {
        const npc = this.getCharacter('NPC');

        if (npc) {
          return {
            label: npc.name,
            color: npc.color,
          };
        }
      }

      return {
        label: 'DM / Narrador',
        color: DM_COLOR,
      };
    }

    const playerCharacter = this.getPlayerCharacter(
      guildId,
      voiceChannelId,
      userId,
    );

    if (playerCharacter) {
      return {
        label: playerCharacter.name,
        color: playerCharacter.color,
      };
    }

    return {
      label: username,
      color: DEFAULT_COLOR,
    };
  }

  static isModeButton(customId: string): boolean {
    return customId.startsWith(BUTTON_PREFIX);
  }

  static isCharacterModeComponent(customId: string): boolean {
    return this.isModeButton(customId);
  }

  private static actionFromComponent(
    customId: string,
  ): string | null {
    if (!this.isModeButton(customId)) {
      return null;
    }

    const parts = customId
      .slice(BUTTON_PREFIX.length)
      .split(':');

    if (parts.length < 3) {
      return null;
    }

    return parts.slice(2).join(':');
  }

  static isChooseCharacterButton(customId: string): boolean {
    return this.actionFromComponent(customId) === 'choose';
  }

  static isCharacterSelectionMenu(customId: string): boolean {
    return (
      this.actionFromComponent(customId) ===
      'select-character'
    );
  }

  static voiceChannelIdFromButton(
    customId: string,
  ): string | null {
    if (!this.isModeButton(customId)) {
      return null;
    }

    const parts = customId
      .slice(BUTTON_PREFIX.length)
      .split(':');

    return parts[0] || null;
  }

  static sessionTokenFromButton(
    customId: string,
  ): string | null {
    if (!this.isModeButton(customId)) {
      return null;
    }

    const parts = customId
      .slice(BUTTON_PREFIX.length)
      .split(':');

    return parts[1] || null;
  }

  static modeFromButton(
    customId: string,
  ): {
    mode: SpeakerMode;
    characterName: string | null;
  } | null {
    if (!this.isModeButton(customId)) {
      return null;
    }

    const action = this.actionFromComponent(customId);

    if (action === 'dm') {
      return {
        mode: 'dm',
        characterName: null,
      };
    }

    if (action === 'npc') {
      return {
        mode: 'npc',
        characterName: 'NPC',
      };
    }

    if (!action?.startsWith('char:')) {
      return null;
    }

    try {
      return {
        mode: 'character',
        characterName: decodeURIComponent(
          action.slice('char:'.length),
        ),
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
    const customId =
      `${BUTTON_PREFIX}${voiceChannelId}:${sessionToken}:${action}`;

    if (customId.length > MAX_CUSTOM_ID_LENGTH) {
      throw new Error(
        `Character mode custom ID is too long: ${customId.length}`,
      );
    }

    return customId;
  }

  static buildPanelContent(
    guildId: string,
    voiceChannelId: string,
    userId: string,
  ): string {
    const mode = this.getMode(
      guildId,
      voiceChannelId,
      userId,
    );

    let active = 'DM / Narrador';

    if (
      mode.mode === 'character' &&
      mode.characterName
    ) {
      active =
        this.getCharacter(mode.characterName)?.name ??
        'DM / Narrador';
    } else if (mode.mode === 'npc') {
      active = 'NPC';
    }

    return [
      'Controles da transcrição ao vivo',
      `Modo atual da DM <@${userId}>: **${active}**`,
      'Jogadores podem usar **Escolher meu personagem** para definir seu personagem nesta sessão.',
      'A mudança vale para as próximas falas reconhecidas.',
    ].join('\n');
  }

  static buildPanelComponents(
    voiceChannelId: string,
    sessionToken: string,
  ): ActionRowBuilder<ButtonBuilder>[] {
    const buttons: ButtonBuilder[] = [
      new ButtonBuilder()
        .setCustomId(
          this.buildButtonCustomId(
            voiceChannelId,
            sessionToken,
            'choose',
          ),
        )
        .setLabel('Escolher meu personagem')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(
          this.buildButtonCustomId(
            voiceChannelId,
            sessionToken,
            'dm',
          ),
        )
        .setLabel('DM / Narrador')
        .setStyle(ButtonStyle.Secondary),
    ];

    const npc = this.getCharacter('NPC');

    if (npc) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(
            this.buildButtonCustomId(
              voiceChannelId,
              sessionToken,
              'npc',
            ),
          )
          .setLabel(npc.name.slice(0, 80))
          .setStyle(ButtonStyle.Success),
      );
    }

    for (const character of this.getCharacters()) {
      if (
        character.name.trim().toLocaleLowerCase() ===
        NPC_NAME
      ) {
        continue;
      }

      if (
        buttons.length >=
        MAX_BUTTONS_PER_ROW * MAX_COMPONENT_ROWS
      ) {
        break;
      }

      const encoded = encodeURIComponent(
        character.name,
      );

      buttons.push(
        new ButtonBuilder()
          .setCustomId(
            this.buildButtonCustomId(
              voiceChannelId,
              sessionToken,
              `char:${encoded}`,
            ),
          )
          .setLabel(character.name.slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      );
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    for (
      let index = 0;
      index < buttons.length;
      index += MAX_BUTTONS_PER_ROW
    ) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            buttons.slice(
              index,
              index + MAX_BUTTONS_PER_ROW,
            ),
          ),
      );
    }

    return rows.slice(0, MAX_COMPONENT_ROWS);
  }

  static buildPlayerSelectionComponents(
    guildId: string,
    voiceChannelId: string,
    sessionToken: string,
    userId: string,
  ): ActionRowBuilder<StringSelectMenuBuilder>[] {
    const current = this.getPlayerCharacter(
      guildId,
      voiceChannelId,
      userId,
    );

    const availableCharacters =
      this.getAvailablePlayerCharacters(
        guildId,
        voiceChannelId,
        userId,
      );

    const orderedCharacters = current
      ? [
          current,
          ...availableCharacters.filter(
            (character) =>
              character.name.toLocaleLowerCase() !==
              current.name.toLocaleLowerCase(),
          ),
        ]
      : availableCharacters;

    const options = orderedCharacters
      .slice(0, MAX_SELECT_OPTIONS - 1)
      .map((character) => ({
        label: character.name.slice(0, 100),
        value: encodeURIComponent(character.name),
        description: 'Selecionar este personagem',
        default:
          current?.name.toLocaleLowerCase() ===
          character.name.toLocaleLowerCase(),
      }));

    options.push({
      label: 'Sem personagem',
      value: PLAYER_NONE_VALUE,
      description: 'Voltar a exibir seu nome do Discord',
      default: !current,
    });

    const menu = new StringSelectMenuBuilder()
      .setCustomId(
        this.buildButtonCustomId(
          voiceChannelId,
          sessionToken,
          'select-character',
        ),
      )
      .setPlaceholder(
        current
          ? `Atual: ${current.name}`
          : 'Selecione seu personagem',
      )
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options);

    return [
      new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(menu),
    ];
  }
}
