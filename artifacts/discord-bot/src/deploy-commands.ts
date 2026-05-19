/**
 * Run this script once to register slash commands with Discord.
 *
 * For a single guild (instant):
 *   COMMAND_GUILD_ID=your_guild_id ts-node src/deploy-commands.ts
 *
 * For global commands (takes up to 1 hour to propagate):
 *   ts-node src/deploy-commands.ts --global
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { getCommandsJSON } from './bot';
import { log } from './logger';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.COMMAND_GUILD_ID;
const isGlobal = process.argv.includes('--global');

if (!token || !clientId) {
  log.error('DISCORD_TOKEN and CLIENT_ID must be set in your .env file.');
  process.exit(1);
}

if (!isGlobal && !guildId) {
  log.error('COMMAND_GUILD_ID must be set for guild-scoped deployment (or pass --global).');
  process.exit(1);
}

const rest = new REST().setToken(token);
const commands = getCommandsJSON();

(async () => {
  try {
    log.info(`Registering ${commands.length} slash command(s) ${isGlobal ? 'globally' : `to guild ${guildId}`}...`);

    const route = isGlobal
      ? Routes.applicationCommands(clientId)
      : Routes.applicationGuildCommands(clientId, guildId!);

    const data = await rest.put(route, { body: commands }) as unknown[];
    log.info(`Successfully registered ${data.length} command(s).`);
  } catch (err: unknown) {
    log.error(`Failed to register commands: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
})();
