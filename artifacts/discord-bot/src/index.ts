import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { setupBot } from './bot';
import { log } from './logger';

const requiredEnv = ['DISCORD_TOKEN', 'CLIENT_ID'];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  log.error(`Missing required environment variables: ${missing.join(', ')}`);
  log.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

setupBot(client);

client.login(process.env.DISCORD_TOKEN).catch((err: Error) => {
  log.error(`Failed to log in: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (err: unknown) => {
  log.error(`Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`);
});

process.on('SIGINT', () => {
  log.info('Shutting down...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down...');
  client.destroy();
  process.exit(0);
});
