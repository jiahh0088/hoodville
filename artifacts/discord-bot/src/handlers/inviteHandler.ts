import {
  Client,
  GuildMember,
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
  sourceGuildCount: number;
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

function formatMessage(template: string, member: GuildMember, inviteLink: string, sourceName: string): string {
  return template
    .replace(/{username}/g, member.user.username)
    .replace(/{display_name}/g, member.displayName)
    .replace(/{server_name}/g, sourceName)
    .replace(/{invite_link}/g, inviteLink);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface EligibleEntry {
  member: GuildMember;
  sourceGuildIds: string[];
}

export async function runInviteCampaign(
  client: Client,
  preset: Preset,
  sourceGuildIds: string[],
  initiatorId: string,
  statusChannel: TextChannel
): Promise<void> {
  if (isCampaignRunning()) {
    throw new Error('A campaign is already running. Use `/invite stop` to cancel it first.');
  }

  const roleIds: string[] = JSON.parse(preset.role_ids);
  const filterByRoles = roleIds.length > 0;

  // Fetch all source guilds and their members in parallel
  const guildFetches = sourceGuildIds.map(async (guildId) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      log.warn(`Bot is not in guild ${guildId} — skipping.`);
      return { guildId, members: null };
    }
    try {
      const members = await guild.members.fetch();
      log.info(`Fetched ${members.size} members from ${guild.name} (${guildId})`);
      return { guildId, members };
    } catch (err) {
      log.warn(`Failed to fetch members from guild ${guildId}: ${err}`);
      return { guildId, members: null };
    }
  });

  const results = await Promise.all(guildFetches);

  // Merge members across all guilds, dedup by user ID
  // If a user is in multiple source guilds they get ONE DM but are logged in all of them
  const mergedMap = new Map<string, EligibleEntry>();

  let totalSkipped = 0;

  for (const { guildId, members } of results) {
    if (!members) continue;

    for (const [, member] of members) {
      if (member.user.bot) continue;

      const alreadyInvited = inviteLogRepo.hasBeenInvited(member.user.id, guildId);
      if (alreadyInvited) {
        if (!mergedMap.has(member.user.id)) totalSkipped++;
        continue;
      }

      if (filterByRoles && !roleIds.some((rid) => member.roles.cache.has(rid))) continue;

      if (mergedMap.has(member.user.id)) {
        // User appears in multiple source guilds — just add this guild to their log list
        mergedMap.get(member.user.id)!.sourceGuildIds.push(guildId);
      } else {
        mergedMap.set(member.user.id, { member, sourceGuildIds: [guildId] });
      }
    }
  }

  const eligibleEntries = Array.from(mergedMap.values());
  const total = eligibleEntries.length;
  const validSourceCount = results.filter((r) => r.members !== null).length;

  const campaignId = campaignRepo.create(
    preset.name,
    sourceGuildIds.join(','),
    initiatorId,
    total
  );

  activeCampaign = {
    campaignId,
    cancelled: false,
    statusMessage: null,
    sent: 0,
    failed: 0,
    skipped: totalSkipped,
    total,
    sourceGuildCount: validSourceCount,
  };

  const sourceLine = validSourceCount === 1
    ? `Source: \`${sourceGuildIds[0]}\``
    : `Sources: **${validSourceCount}** servers`;

  const statusMsg = await statusChannel.send(
    `📨 **Invite Campaign Started** — Preset: \`${preset.name}\`\n` +
    `${sourceLine}\n` +
    `👥 Unique eligible: **${total}** | ⏭️ Already invited: **${totalSkipped}**\n` +
    `✅ Sent: **0** | ❌ Failed: **0** | Progress: **0%**\n` +
    `_Sending at 1 DM every ${DM_DELAY_MS}ms..._`
  );
  activeCampaign.statusMessage = statusMsg;

  for (let i = 0; i < eligibleEntries.length; i++) {
    if (activeCampaign.cancelled) {
      log.info(`Campaign ${campaignId} cancelled at ${i}/${total}`);
      break;
    }

    const { member, sourceGuildIds: memberSourceIds } = eligibleEntries[i];
    const sourceName = client.guilds.cache.get(memberSourceIds[0])?.name ?? memberSourceIds[0];
    const message = formatMessage(preset.message_template, member, preset.invite_link, sourceName);

    try {
      await member.send(message);
      // Record in invite log for every source guild this user was in
      for (const sid of memberSourceIds) {
        inviteLogRepo.record(member.user.id, member.user.username, sid, preset.name, 'sent');
      }
      campaignRepo.increment(campaignId, 'total_sent');
      activeCampaign.sent++;
      log.info(`[${i + 1}/${total}] Sent DM to ${member.user.tag} (from ${memberSourceIds.length} guild(s))`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      for (const sid of memberSourceIds) {
        inviteLogRepo.record(member.user.id, member.user.username, sid, preset.name, 'failed', errorMsg);
      }
      campaignRepo.increment(campaignId, 'total_failed');
      activeCampaign.failed++;
      log.warn(`[${i + 1}/${total}] Failed DM to ${member.user.tag}: ${errorMsg}`);
    }

    if ((i + 1) % 5 === 0 || i === eligibleEntries.length - 1) {
      const pct = Math.round(((activeCampaign.sent + activeCampaign.failed) / total) * 100);
      try {
        await statusMsg.edit(
          `📨 **Invite Campaign Running** — Preset: \`${preset.name}\`\n` +
          `${sourceLine}\n` +
          `👥 Unique eligible: **${total}** | ⏭️ Already invited: **${totalSkipped}**\n` +
          `✅ Sent: **${activeCampaign.sent}** | ❌ Failed: **${activeCampaign.failed}** | Progress: **${pct}%**\n` +
          `_Processing ${i + 1} of ${total}..._`
        );
      } catch { /* ignore if message deleted */ }
    }

    if (i < eligibleEntries.length - 1) await sleep(DM_DELAY_MS);
  }

  const finalStatus = activeCampaign.cancelled ? 'cancelled' : 'completed';
  campaignRepo.finish(campaignId, finalStatus);

  const icon = finalStatus === 'completed' ? '✅' : '🛑';
  try {
    await statusMsg.edit(
      `${icon} **Campaign ${finalStatus === 'completed' ? 'Complete' : 'Cancelled'}** — Preset: \`${preset.name}\`\n` +
      `${sourceLine}\n` +
      `👥 Unique eligible: **${total}** | ⏭️ Already invited: **${totalSkipped}**\n` +
      `✅ Sent: **${activeCampaign.sent}** | ❌ Failed (DMs closed): **${activeCampaign.failed}**`
    );
  } catch { /* ignore */ }

  log.info(`Campaign ${campaignId} ${finalStatus}: sent=${activeCampaign.sent}, failed=${activeCampaign.failed}, guilds=${validSourceCount}`);
  activeCampaign = null;
}
