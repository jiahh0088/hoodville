import {
  Client,
  GuildMember,
  Collection,
  Snowflake,
  TextChannel,
  Message,
} from 'discord.js';
import { campaignRepo, inviteLogRepo, Preset } from '../db/database';
import { log } from '../logger';

const DM_DELAY_MS = parseInt(process.env.DM_DELAY_MS ?? '1500', 10);

interface CampaignState {
  campaignId: number;
  cancelled: boolean;
  statusMessage: Message | null;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
}

let activeCampaign: CampaignState | null = null;

export function isCampaignRunning(): boolean {
  return activeCampaign !== null && !activeCampaign.cancelled;
}

export function cancelActiveCampaign(): boolean {
  if (!activeCampaign) return false;
  activeCampaign.cancelled = true;
  return true;
}

export function getActiveCampaignStats(): CampaignState | null {
  return activeCampaign;
}

function formatMessage(template: string, member: GuildMember, inviteLink: string): string {
  return template
    .replace(/{username}/g, member.user.username)
    .replace(/{server_name}/g, member.guild.name)
    .replace(/{invite_link}/g, inviteLink)
    .replace(/{display_name}/g, member.displayName);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runInviteCampaign(
  client: Client,
  preset: Preset,
  oldGuildId: string,
  initiatorId: string,
  statusChannel: TextChannel
): Promise<void> {
  if (isCampaignRunning()) {
    throw new Error('A campaign is already running. Use `/invite stop` to cancel it first.');
  }

  const oldGuild = client.guilds.cache.get(oldGuildId);
  if (!oldGuild) throw new Error(`Bot is not in the old server (ID: ${oldGuildId}). Make sure the bot is invited to both servers.`);

  log.info(`Fetching all members from guild: ${oldGuild.name} (${oldGuildId})`);

  let allMembers: Collection<Snowflake, GuildMember>;
  try {
    allMembers = await oldGuild.members.fetch();
  } catch (err) {
    throw new Error(`Failed to fetch members. Make sure the bot has the SERVER MEMBERS INTENT enabled in the developer portal. Error: ${err}`);
  }

  const roleIds: string[] = JSON.parse(preset.role_ids);
  const filterByRoles = roleIds.length > 0;

  const eligibleMembers = allMembers.filter((m) => {
    if (m.user.bot) return false;
    if (inviteLogRepo.hasBeenInvited(m.user.id, oldGuildId)) return false;
    if (filterByRoles) {
      return roleIds.some((rid) => m.roles.cache.has(rid));
    }
    return true;
  });

  const alreadyInvited = allMembers.filter(
    (m) => !m.user.bot && inviteLogRepo.hasBeenInvited(m.user.id, oldGuildId)
  ).size;

  const total = eligibleMembers.size;
  const campaignId = campaignRepo.create(preset.name, oldGuildId, initiatorId, total);

  activeCampaign = {
    campaignId,
    cancelled: false,
    statusMessage: null,
    sent: 0,
    failed: 0,
    skipped: alreadyInvited,
    total,
  };

  const statusMsg = await statusChannel.send(
    `📨 **Invite Campaign Started** — Preset: \`${preset.name}\`\n` +
    `👥 Eligible: **${total}** | ⏭️ Already invited: **${alreadyInvited}**\n` +
    `✅ Sent: **0** | ❌ Failed: **0** | Progress: **0%**\n` +
    `_Sending at 1 DM every ${DM_DELAY_MS}ms to respect rate limits..._`
  );
  activeCampaign.statusMessage = statusMsg;

  let updateCounter = 0;
  const membersArray = Array.from(eligibleMembers.values());

  for (let i = 0; i < membersArray.length; i++) {
    if (activeCampaign.cancelled) {
      log.info(`Campaign ${campaignId} cancelled at ${i}/${total}`);
      break;
    }

    const member = membersArray[i];
    const message = formatMessage(preset.message_template, member, preset.invite_link);

    try {
      await member.send(message);
      inviteLogRepo.record(member.user.id, member.user.username, oldGuildId, preset.name, 'sent');
      campaignRepo.increment(campaignId, 'total_sent');
      activeCampaign.sent++;
      log.info(`[${i + 1}/${total}] Sent DM to ${member.user.tag}`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      inviteLogRepo.record(member.user.id, member.user.username, oldGuildId, preset.name, 'failed', errorMsg);
      campaignRepo.increment(campaignId, 'total_failed');
      activeCampaign.failed++;
      log.warn(`[${i + 1}/${total}] Failed DM to ${member.user.tag}: ${errorMsg}`);
    }

    updateCounter++;
    if (updateCounter % 5 === 0 || i === membersArray.length - 1) {
      const pct = Math.round(((activeCampaign.sent + activeCampaign.failed) / total) * 100);
      try {
        await statusMsg.edit(
          `📨 **Invite Campaign Running** — Preset: \`${preset.name}\`\n` +
          `👥 Eligible: **${total}** | ⏭️ Already invited: **${alreadyInvited}**\n` +
          `✅ Sent: **${activeCampaign.sent}** | ❌ Failed: **${activeCampaign.failed}** | Progress: **${pct}%**\n` +
          `_Processing ${i + 1} of ${total}..._`
        );
      } catch { /* editing can fail if message was deleted */ }
    }

    if (i < membersArray.length - 1) {
      await sleep(DM_DELAY_MS);
    }
  }

  const finalStatus = activeCampaign.cancelled ? 'cancelled' : 'completed';
  campaignRepo.finish(campaignId, finalStatus);

  const icon = finalStatus === 'completed' ? '✅' : '🛑';
  try {
    await statusMsg.edit(
      `${icon} **Invite Campaign ${finalStatus === 'completed' ? 'Complete' : 'Cancelled'}** — Preset: \`${preset.name}\`\n` +
      `👥 Eligible: **${total}** | ⏭️ Skipped (already invited): **${alreadyInvited}**\n` +
      `✅ Sent: **${activeCampaign.sent}** | ❌ Failed (DMs closed): **${activeCampaign.failed}**`
    );
  } catch { /* ignore */ }

  log.info(`Campaign ${campaignId} ${finalStatus}: sent=${activeCampaign.sent}, failed=${activeCampaign.failed}`);
  activeCampaign = null;
}
