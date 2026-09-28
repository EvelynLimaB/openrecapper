process.env.CHARACTER_DM_USER_IDS = 'dm-test';
process.env.CHARACTER_DEFINITIONS =
  'Kasane:E74C3C,Shiki:F1C40F,Conrad:000000,Guava:E67E22,Arsene:3498DB,Mello:795548,NPC:2ECC71';

const { CharacterModeService } =
  require('../src/services/character-mode-service');

const guildId = 'guild-test';
const voiceChannelId = 'voice-test';
const dmUserId = 'dm-test';
const playerOne = 'player-one';
const playerTwo = 'player-two';

const dm =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    dmUserId,
    'DungeonMaster',
  );

if (dm.label !== 'DM / Narrador' || dm.color !== '#FFFFFF') {
  throw new Error('Invalid DM default presentation.');
}

const player =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    playerOne,
    'Player One',
  );

if (
  player.label !== 'Player One' ||
  player.color !== '#95A5A6'
) {
  throw new Error('Invalid unassigned player presentation.');
}

const assignment =
  CharacterModeService.assignPlayerCharacter(
    guildId,
    voiceChannelId,
    playerOne,
    'Kasane',
  );

if (
  !assignment.ok ||
  assignment.character?.name !== 'Kasane'
) {
  throw new Error('Player character assignment failed.');
}

const kasane =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    playerOne,
    'Player One',
  );

if (
  kasane.label !== 'Kasane' ||
  kasane.color !== '#E74C3C'
) {
  throw new Error('Player character presentation failed.');
}

const presentationMap =
  CharacterModeService.buildPresentationMap(
    guildId,
    voiceChannelId,
    new Map([
      [playerOne, 'Player One'],
      [dmUserId, 'DungeonMaster'],
    ]),
  );

CharacterModeService.clearSession(
  guildId,
  voiceChannelId,
);

if (
  presentationMap.get(playerOne)?.label !== 'Kasane' ||
  presentationMap.get(playerOne)?.color !== '#E74C3C'
) {
  throw new Error('Presentation snapshot did not retain pre-clear state.');
}

const restoredAssignment =
  CharacterModeService.assignPlayerCharacter(
    guildId,
    voiceChannelId,
    playerOne,
    'Kasane',
  );

if (!restoredAssignment.ok) {
  throw new Error('Failed to restore test assignment after snapshot check.');
}

if (
  presentationMap.get(playerOne)?.label !== 'Kasane' ||
  presentationMap.get(playerOne)?.color !== '#E74C3C' ||
  presentationMap.get(dmUserId)?.label !== 'DM / Narrador' ||
  presentationMap.get(dmUserId)?.color !== '#FFFFFF'
) {
  throw new Error('Presentation map failed.');
}

CharacterModeService.setMode(
  guildId,
  voiceChannelId,
  dmUserId,
  'character',
  'Arsene',
);

const dmArsene =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    dmUserId,
    'DungeonMaster',
  );

if (
  dmArsene.label !== 'Arsene' ||
  dmArsene.color !== '#3498DB'
) {
  throw new Error('DM character presentation failed.');
}

CharacterModeService.setMode(
  guildId,
  voiceChannelId,
  dmUserId,
  'npc',
  'NPC',
);

const dmNpc =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    dmUserId,
    'DungeonMaster',
  );

if (
  dmNpc.label !== 'NPC' ||
  dmNpc.color !== '#2ECC71'
) {
  throw new Error('DM NPC presentation failed.');
}

CharacterModeService.setMode(
  guildId,
  voiceChannelId,
  dmUserId,
  'dm',
  null,
);

const duplicate =
  CharacterModeService.assignPlayerCharacter(
    guildId,
    voiceChannelId,
    playerTwo,
    'Kasane',
  );

if (
  duplicate.ok ||
  duplicate.reason !== 'reserved' ||
  duplicate.conflictUserId !== playerOne
) {
  throw new Error('Duplicate character protection failed.');
}

const otherSession =
  CharacterModeService.assignPlayerCharacter(
    guildId,
    'voice-other',
    playerTwo,
    'Kasane',
  );

if (
  !otherSession.ok ||
  otherSession.character?.name !== 'Kasane'
) {
  throw new Error('Character reservation leaked across sessions.');
}

const availableForTwo =
  CharacterModeService.getAvailablePlayerCharacters(
    guildId,
    voiceChannelId,
    playerTwo,
  );

if (
  availableForTwo.some(
    (character) => character.name === 'Kasane',
  )
) {
  throw new Error('Reserved character was exposed as available.');
}

const availableForOne =
  CharacterModeService.getAvailablePlayerCharacters(
    guildId,
    voiceChannelId,
    playerOne,
  );

if (
  !availableForOne.some(
    (character) => character.name === 'Kasane',
  )
) {
  throw new Error('Current character was not kept selectable.');
}

const npcPlayer =
  CharacterModeService.assignPlayerCharacter(
    guildId,
    voiceChannelId,
    playerTwo,
    'NPC',
  );

if (
  npcPlayer.ok ||
  npcPlayer.reason !== 'invalid'
) {
  throw new Error('NPC must remain DM-only.');
}

const id =
  CharacterModeService.buildButtonCustomId(
    voiceChannelId,
    'session123',
    'char:Kasane',
  );

const parsed =
  CharacterModeService.modeFromButton(id);

if (
  CharacterModeService.voiceChannelIdFromButton(id) !==
    voiceChannelId ||
  CharacterModeService.sessionTokenFromButton(id) !==
    'session123' ||
  !parsed ||
  parsed.mode !== 'character' ||
  parsed.characterName !== 'Kasane'
) {
  throw new Error('Invalid character button parsing.');
}

const chooseId =
  CharacterModeService.buildButtonCustomId(
    voiceChannelId,
    'session123',
    'choose',
  );

if (
  !CharacterModeService.isChooseCharacterButton(
    chooseId,
  )
) {
  throw new Error('Player character button parsing failed.');
}

const selectId =
  CharacterModeService.buildButtonCustomId(
    voiceChannelId,
    'session123',
    'select-character',
  );

if (
  !CharacterModeService.isCharacterSelectionMenu(
    selectId,
  )
) {
  throw new Error('Player character select parsing failed.');
}

const rows =
  CharacterModeService.buildPanelComponents(
    voiceChannelId,
    'session123',
  );

if (rows.length < 1 || rows.length > 5) {
  throw new Error('Invalid component row count.');
}

for (const row of rows) {
  if (
    row.components.length < 1 ||
    row.components.length > 5
  ) {
    throw new Error('Invalid button count.');
  }
}

const playerMenuRows =
  CharacterModeService.buildPlayerSelectionComponents(
    guildId,
    voiceChannelId,
    'session123',
    playerTwo,
  );

if (
  playerMenuRows.length !== 1 ||
  playerMenuRows[0].components.length !== 1
) {
  throw new Error('Invalid player selection component.');
}

const playerSelect =
  playerMenuRows[0].components[0].toJSON();

if (
  !('options' in playerSelect) ||
  !Array.isArray(playerSelect.options) ||
  playerSelect.options.length > 25
) {
  throw new Error('Player selection exceeded Discord option limit.');
}

const none =
  CharacterModeService.assignPlayerCharacter(
    guildId,
    voiceChannelId,
    playerOne,
    null,
  );

if (!none.ok || none.character !== null) {
  throw new Error('Failed to clear player character.');
}

const fallback =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    playerOne,
    'Player One',
  );

if (
  fallback.label !== 'Player One' ||
  fallback.color !== '#95A5A6'
) {
  throw new Error('Player fallback presentation failed.');
}

CharacterModeService.clearSession(
  guildId,
  'voice-other',
);
CharacterModeService.clearSession(
  guildId,
  voiceChannelId,
);

const cleared =
  CharacterModeService.getPresentation(
    guildId,
    voiceChannelId,
    playerOne,
    'Player One',
  );

if (
  cleared.label !== 'Player One' ||
  cleared.color !== '#95A5A6'
) {
  throw new Error('Session assignment was not cleared.');
}

console.log(
  'Character mode + player selection tests passed.',
);
