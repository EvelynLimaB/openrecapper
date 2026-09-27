process.env.CHARACTER_DM_USER_IDS =
  'dm-test';

process.env.CHARACTER_DEFINITIONS =
  'Arsene:3498DB,Kasane:9B59B6,Mello:2ECC71,Lorenzo:E67E22';

const {
  CharacterModeService,
} = require(
  '../src/services/character-mode-service',
);

const guildId =
  'guild-test';

const voiceChannelId =
  'voice-test';

const dmUserId =
  'dm-test';

const otherUserId =
  'player-test';

const dm =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    dmUserId,
    'DungeonMaster',
  );

if (
  dm.label !==
    'DM / Narrador' ||
  dm.color !== '#FFFFFF'
) {
  throw new Error(
    'Invalid DM default presentation.',
  );
}

CharacterModeService.setMode(
  guildId,
  voiceChannelId,
  dmUserId,
  'character',
  'Arsene',
);

const arsene =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    dmUserId,
    'DungeonMaster',
  );

if (
  arsene.label !==
    'Arsene' ||
  arsene.color !==
    '#3498DB'
) {
  throw new Error(
    'Invalid Arsene presentation.',
  );
}

const player =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    otherUserId,
    'Player One',
  );

if (
  player.label !==
    'Player One' ||
  player.color !==
    '#95A5A6'
) {
  throw new Error(
    'Invalid participant presentation.',
  );
}

const id =
  CharacterModeService.buildButtonCustomId(
    voiceChannelId,
    'session123',
    'char:Arsene',
  );

const parsed =
  CharacterModeService.modeFromButton(
    id,
  );

if (
  CharacterModeService
    .voiceChannelIdFromButton(id) !==
    voiceChannelId ||
  CharacterModeService
    .sessionTokenFromButton(id) !==
    'session123' ||
  !parsed ||
  parsed.mode !==
    'character' ||
  parsed.characterName !==
    'Arsene'
) {
  throw new Error(
    'Invalid character button parsing.',
  );
}

const rows =
  CharacterModeService.buildPanelComponents(
    voiceChannelId,
    'session123',
  );

if (
  rows.length < 1 ||
  rows.length > 5
) {
  throw new Error(
    'Invalid component row count.',
  );
}

for (
  const row of rows
) {
  if (
    row.components.length <
      1 ||
    row.components.length >
      5
  ) {
    throw new Error(
      'Invalid button count.',
    );
  }
}

CharacterModeService.clearSession(
  guildId,
  voiceChannelId,
);

const cleared =
  CharacterModeService.getMode(
    guildId,
    voiceChannelId,
    dmUserId,
  );

if (
  cleared.mode !==
    'dm' ||
  cleared.characterName !==
    null
) {
  throw new Error(
    'Session mode was not cleared.',
  );
}

console.log(
  'Character mode tests passed.',
);