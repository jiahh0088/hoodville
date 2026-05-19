import {
  Client,
  Collection,
  Events,
  Interaction,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  REST,
  Routes,
} from 'discord.js';
import { log } from './logger';
import { presetRepo } from './db/database';

import * as presetCmd from './commands/preset';
import * as inviteCmd from './commands/invite';
import * as statusCmd from './commands/status';
import * as dryrunCmd from './commands/dryrun';

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commands = new Collection<string, Command>();
commands.set(presetCmd.data.name, presetCmd);
commands.set(inviteCmd.data.name, inviteCmd);
commands.set(statusCmd.data.name, statusCmd);
commands.set(dryrunCmd.data.name, dryrunCmd);

async function registerCommands(client: Client): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID ?? client.user?.id;

  if (!token || !clientId) {
    log.warn('Skipping command registration — DISCORD_TOKEN or CLIENT_ID not set.');
    return;
  }

  const rest = new REST().setToken(token);
  const body = commands.map((c) => c.data.toJSON());

  const guildIds = process.env.COMMAND_GUILD_ID
    ? [process.env.COMMAND_GUILD_ID]
    : Array.from(client.guilds.cache.keys());

  if (guildIds.length === 0) {
    log.warn('Bot is not in any guilds — skipping command registration.');
    return;
  }

  let registered = 0;
  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      registered++;
      log.info(`Commands registered in guild: ${guildId}`);
    } catch (err: unknown) {
      log.warn(`Failed to register commands in guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info(`Auto-registered ${body.length} slash command(s) across ${registered} guild(s).`);
}

export function setupBot(client: Client): void {
  client.once(Events.ClientReady, async (c) => {
    log.info(`Bot ready — logged in as ${c.user.tag}`);
    log.info(`Serving ${c.guilds.cache.size} guild(s)`);
    await registerCommands(c);
  });

  client.on(Events.GuildCreate, async (guild) => {
    log.info(`Joined new guild: ${guild.name} (${guild.id}) — registering commands...`);
    const token = process.env.DISCORD_TOKEN;
    const clientId = process.env.CLIENT_ID ?? client.user?.id;
    if (!token || !clientId) return;
    const rest = new REST().setToken(token);
    const body = commands.map((c) => c.data.toJSON());
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body });
      log.info(`Commands registered in new guild: ${guild.id}`);
    } catch (err: unknown) {
      log.warn(`Failed to register in new guild ${guild.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) {
      log.warn(`Unknown command: ${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Error in /${interaction.commandName}: ${msg}`);
      const reply = { content: `❌ An error occurred: ${msg}`, ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => undefined);
      } else {
        await interaction.reply(reply).catch(() => undefined);
      }
    }
  });

  client.on(Events.Error, (err) => {
    log.error(`Client error: ${err.message}`);
  });
}

async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const commandName = interaction.commandName;

  if (
    (commandName === 'preset' && ['name'].includes(focused.name) && interaction.options.getSubcommand() !== 'create') ||
    (commandName === 'invite' && focused.name === 'preset') ||
    (commandName === 'dryrun' && focused.name === 'preset')
  ) {
    const presets = presetRepo.list();
    const query = focused.value.toString().toLowerCase();
    const choices = presets
      .filter((p) => p.name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((p) => ({ name: p.name, value: p.name }));

    await interaction.respond(choices).catch(() => undefined);
  }
}

export function getCommandsJSON(): unknown[] {
  return commands.map((c) => c.data.toJSON());
}
