# Discord Server Migration Bot

A high-efficiency Discord bot that DMs members from your old server with a customizable invite to your new one. Supports role-based targeting, reusable presets, and a duplicate-protection log.

---

## Features

- **Presets** — Save named configurations with an invite link, target roles, and a custom message template
- **Role filtering** — Target only members with specific roles, or send to everyone
- **Duplicate protection** — SQLite log ensures no member is DM'd twice across runs/restarts
- **Live progress** — Real-time campaign status updates in your channel
- **Rate-limit safe** — Configurable delay between DMs (default 1.5s)
- **Railway ready** — Deploy directly from GitHub with zero config

---

## Quick Start

### 1. Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Go to **Bot** tab → **Reset Token** and copy it
3. Under **Privileged Gateway Intents**, enable:
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent** (optional)
4. Go to **OAuth2 → URL Generator**, select:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Read Message History`
5. Invite the bot to **both** your old AND new server

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in your `.env`:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
COMMAND_GUILD_ID=your_old_or_admin_server_id
OLD_GUILD_ID=your_old_server_id
```

### 3. Install & Build

```bash
npm install
npm run build
```

### 4. Register Slash Commands

```bash
# Guild-specific (instant):
npm run deploy-commands

# Or globally (takes up to 1 hour):
npx ts-node src/deploy-commands.ts --global
```

### 5. Run

```bash
npm start
```

---

## Commands

All commands require **Administrator** permission.

### `/preset create`
```
/preset create name:summer-2024 invite_link:https://discord.gg/xxx message:Hey {username}! Join our new server: {invite_link} roles:123456789,987654321
```

| Option | Required | Description |
|--------|----------|-------------|
| `name` | ✅ | Unique preset name (no spaces) |
| `invite_link` | ✅ | The invite link to your NEW server |
| `message` | ✅ | DM message. Supports: `{username}`, `{display_name}`, `{server_name}`, `{invite_link}` |
| `roles` | ❌ | Comma-separated role IDs to target. Leave blank for all members |

### `/preset list` — List all saved presets
### `/preset view name:xxx` — See full details of a preset
### `/preset edit name:xxx` — Edit invite link, message, or roles
### `/preset delete name:xxx` — Delete a preset

---

### `/invite start preset:xxx`
Begins a campaign using the specified preset. Fetches all eligible members, skips already-invited users, and DMs each member with your customized message.

### `/invite stop` — Cancel the running campaign
### `/invite status` — View live progress or historical stats
### `/invite clear_log` — Reset the invite log (allows re-inviting everyone)

---

### `/logstats`
View detailed stats: total invited, sent, failed, and last campaign details.

---

## Deploying to Railway

1. Push this folder to a GitHub repository
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repo
4. Add environment variables (copy from `.env.example`)
5. Railway auto-detects the `railway.toml` and builds/starts the bot

> **Important:** After deployment, run `/invite start` from Discord. The bot needs to be in both servers.

---

## Message Template Variables

| Variable | Replaced With |
|----------|---------------|
| `{username}` | Discord username (e.g. `john`) |
| `{display_name}` | Server nickname or username |
| `{server_name}` | Name of the old server |
| `{invite_link}` | The invite link from the preset |

**Example:**
```
Hey {username}! We're moving our community to a new server. 
Join us here: {invite_link}

Hope to see you there! 🎉
```

---

## Notes

- Members with DMs disabled will be logged as `failed` — this is normal
- Bots are automatically skipped
- The bot must have permission to DM members (not blocked)
- Railway's free tier restarts containers; the SQLite DB persists on the volume
