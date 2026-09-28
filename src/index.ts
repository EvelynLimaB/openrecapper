import { Client, GatewayIntentBits, Events, Collection, Interaction, VoiceState, Partials, MessageReaction, PartialMessageReaction, User, PartialUser, MessageFlags } from 'discord.js';
import { Config, validateConfig } from './config';
import { setClient } from './client';
import { recordCommand } from './commands/record';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { grapevineCommand } from './commands/grapevine';
import { scheduleCommand } from './commands/schedule';
import { recordAccessCommand } from './commands/record-access';
import { setSummaryChannelCommand } from './commands/set-summary-channel';
import { openrecapperIssueCommand } from './commands/openrecapper-issue';
import { WorkerManager } from './services/worker-manager';
import { RecorderPool } from './services/recorder-pool';
import { CharacterModeService } from './services/character-mode-service';
import { testScheduleCommand } from './commands/test-schedule';
import { startScheduler, stopScheduler } from './services/scheduler';
import { loadGrapevineConfig, handleReactionAdd } from './services/grapevine-service';
import { runStartupHealthChecks } from './services/health-check';
import { startCleanupScheduler } from './services/recording-cleanup';

validateConfig();

// Prevent DAVE/voice errors from crashing the process
process.on('unhandledRejection', (err) => {
  console.error('[Process] Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
  // Only exit on truly fatal errors, not DAVE key exchange issues
  if (err.message?.includes('ECONNRESET') || err.message?.includes('EPIPE')) {
    process.exit(1);
  }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent, // privileged: needed to forward message text
  ],
  // Reactions on older (uncached) messages arrive as partials; enable so we can fetch them.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

const commands = new Collection<string, any>();
commands.set(recordCommand.data.name, recordCommand);
commands.set(stopCommand.data.name, stopCommand);
commands.set(statusCommand.data.name, statusCommand);
commands.set(testScheduleCommand.data.name, testScheduleCommand);
commands.set(grapevineCommand.data.name, grapevineCommand);
commands.set(scheduleCommand.data.name, scheduleCommand);
commands.set(recordAccessCommand.data.name, recordAccessCommand);
commands.set(setSummaryChannelCommand.data.name, setSummaryChannelCommand);
commands.set(openrecapperIssueCommand.data.name, openrecapperIssueCommand);

setClient(client);

const pool = RecorderPool.getInstance();
pool.register(client); // primary doubles as a recorder

// Voice-only recorder identities (tokens[1..]) — minimal intents; all text,
// interaction, and member-resolution work stays on the primary.
const recorderClients: Client[] = Config.DISCORD_TOKENS.slice(1).map(() =>
  new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] })
);
for (const rc of recorderClients) {
  rc.once(Events.ClientReady, (c) => console.log(`✅ Recorder logged in as ${c.user.tag}`));
  pool.register(rc);
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  WorkerManager.getInstance().sweepOrphanSessions();
  startScheduler();
  loadGrapevineConfig();
  runStartupHealthChecks(c).catch((err) => console.error('[HealthCheck] Unexpected error:', err));
  startCleanupScheduler();
});

client.on(Events.MessageReactionAdd, async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
  try {
    await handleReactionAdd(reaction, user);
  } catch (err) {
    console.error('[Grapevine] Unhandled error in reaction handler:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  console.log(`[Interaction] Received: type=${interaction.type} id=${interaction.id}`);

  // Autocomplete (e.g. /schedule's `schedule:` option) arrives as its own
  // interaction type and must be answered separately from command execution.
  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error(`[Interaction] Autocomplete error for /${interaction.commandName}:`, err);
      }
    }
    return;
  }

  if (
    (interaction.isButton() ||
      interaction.isStringSelectMenu()) &&
    CharacterModeService.isCharacterModeComponent(
      interaction.customId,
    )
  ) {
    const voiceChannelId =
      CharacterModeService.voiceChannelIdFromButton(
        interaction.customId,
      );

    if (!voiceChannelId) {
      await interaction.reply({
        content: 'Painel de modo inválido.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const session =
      WorkerManager
        .getInstance()
        .getSession(voiceChannelId);

    if (!session?.liveTranscription) {
      await interaction.reply({
        content:
          'A gravação desta sessão não está mais ativa.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      if (interaction.isButton()) {
        await session.liveTranscription.handleCharacterModeButton(
          interaction,
        );
      } else if (
        interaction.isStringSelectMenu() &&
        CharacterModeService.isCharacterSelectionMenu(
          interaction.customId,
        )
      ) {
        await session.liveTranscription.handleCharacterModeSelect(
          interaction,
        );
      } else {
        await interaction.reply({
          content: 'Componente de personagem inválido.',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      console.error(
        '[Interaction] Character mode component error:',
        err,
      );

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content:
            'Não foi possível atualizar o modo de fala.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  console.log(`[Interaction] Command: /${interaction.commandName}`);
  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing /${interaction.commandName}:`, error);
    const reply = {
      content: '\u274c An error occurred.',
      flags: MessageFlags.Ephemeral as const,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

// Auto-stop recording when the bot is the last one in the voice channel
const stoppingChannels = new Set<string>();
client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
  // We care about someone leaving a channel (oldState had a channel)
  if (!oldState.channel) return;

  const manager = WorkerManager.getInstance();
  const channelId = oldState.channel.id;

  // Is this channel being recorded?
  if (!manager.isRecording(channelId)) return;

  // Guard against double-stop from simultaneous leave events
  if (stoppingChannels.has(channelId)) return;

  // Count non-bot members still in the channel
  const members = oldState.channel.members.filter((m) => !m.user.bot);
  if (members.size > 0) return;

  // Everyone left — auto-stop
  stoppingChannels.add(channelId);
  console.log(`[AutoStop] All users left <#${channelId}>, stopping recording`);
  try {
    await manager.stopRecording(channelId);
  } catch (err) {
    console.error('[AutoStop] Failed to stop recording:', err);
  } finally {
    stoppingChannels.delete(channelId);
  }
});

let shuttingDown = false;
async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] Received ${signal}; stopping scheduler and active recordings before exit`);
  try {
    stopScheduler();
    await WorkerManager.getInstance().stopAllActiveSessions(signal);
    await client.destroy();
    await Promise.allSettled(recorderClients.map((rc) => rc.destroy()));
    console.log('[Shutdown] Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[Shutdown] Graceful shutdown failed:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

client.login(Config.DISCORD_TOKENS[0]);
// Recorder logins are independent: one failing just reduces per-guild
// capacity (the pool skips non-ready clients); it must not take the bot down.
Config.DISCORD_TOKENS.slice(1).forEach((token, i) => {
  recorderClients[i].login(token).catch((err) => {
    console.error(`[Startup] Recorder client ${i + 1} failed to log in (capacity reduced):`, err);
  });
});
