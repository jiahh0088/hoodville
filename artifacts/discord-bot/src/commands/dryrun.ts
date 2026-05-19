import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  GuildMember,
} from 'discord.js';
import { presetRepo, inviteLogRepo } from '../db/database';
import { log } from '../logger';

export const data = new SlashCommandBuilder()
  .setName('dryrun')
  .setDescription("Preview exactly who would be DM'd — no messages sent")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) =>
    o.setName('preset').setDescription('Preset to simulate').setRequired(true).setAutocomplete(true)
  )
  .addStringOption((o) =>
    o
      .setName('source_guilds')
      .setDescription('Old server ID(s) — comma-separated, up to 10 (defaults to OLD_GUILD_ID env var)')
      .setRequired(false)
  )
  .addIntegerOption((o) =>
    o
      .setName('sample_size')
      .setDescription('How many example usernames to show (default 10, max 25)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(25)
  );

function parseGuildIds(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const presetName = interaction.options.getString('preset', true);
  const rawGuilds = interaction.options.getString('source_guilds') ?? process.env.OLD_GUILD_ID ?? '';
  const sampleSize = interaction.options.getInteger('sample_size') ?? 10;

  if (!rawGuilds) {
    await interaction.editReply('❌ No source guild(s) specified and `OLD_GUILD_ID` env var is not set.');
    return;
  }

  const sourceGuildIds = parseGuildIds(rawGuilds);
  const preset = presetRepo.get(presetName);
  if (!preset) {
    await interaction.editReply(`❌ No preset named \`${presetName}\` found. Use \`/preset list\` to see available presets.`);
    return;
  }

  const roleIds: string[] = JSON.parse(preset.role_ids);
  const filterByRoles = roleIds.length > 0;

  // Fetch members from all guilds in parallel
  const guildFetches = sourceGuildIds.map(async (guildId) => {
    const guild = interaction.client.guilds.cache.get(guildId);
    if (!guild) return { guildId, guildName: guildId, members: null, error: 'Bot not in this server' };
    try {
      const members = await guild.members.fetch();
      return { guildId, guildName: guild.name, members, error: null };
    } catch (err) {
      return { guildId, guildName: guildId, members: null, error: String(err) };
    }
  });

  const results = await Promise.all(guildFetches);

  // Merge and dedup eligible members by user ID
  const mergedMap = new Map<string, { member: GuildMember; guilds: string[] }>();
  let totalBots = 0;
  let totalAlreadyInvited = 0;
  let totalRoleFiltered = 0;

  for (const { guildId, members } of results) {
    if (!members) continue;
    for (const [, member] of members) {
      if (member.user.bot) { totalBots++; continue; }
      if (inviteLogRepo.hasBeenInvited(member.user.id, guildId)) {
        if (!mergedMap.has(member.user.id)) totalAlreadyInvited++;
        continue;
      }
      if (filterByRoles && !roleIds.some((rid) => member.roles.cache.has(rid))) {
        if (!mergedMap.has(member.user.id)) totalRoleFiltered++;
        continue;
      }
      if (mergedMap.has(member.user.id)) {
        mergedMap.get(member.user.id)!.guilds.push(guildId);
      } else {
        mergedMap.set(member.user.id, { member, guilds: [guildId] });
      }
    }
  }

  const willReceiveDM = Array.from(mergedMap.values());
  const totalEligible = willReceiveDM.length;
  const sampleEntries = willReceiveDM.slice(0, sampleSize);

  const dmDelay = parseInt(process.env.DM_DELAY_MS ?? '1500', 10);
  const estimatedSeconds = Math.ceil((totalEligible * dmDelay) / 1000);
  const estimatedTime = estimatedSeconds < 60
    ? `~${estimatedSeconds}s`
    : `~${Math.floor(estimatedSeconds / 60)}m ${estimatedSeconds % 60}s`;

  const successGuilds = results.filter((r) => r.members !== null);
  const failedGuilds = results.filter((r) => r.members === null);

  const guildSummary = successGuilds
    .map((r) => `✅ **${r.guildName}** (\`${r.guildId}\`)`)
    .concat(failedGuilds.map((r) => `❌ \`${r.guildId}\` — ${r.error}`))
    .join('\n') || '_None_';

  const messagePreview = preset.message_template
    .replace(/{username}/g, sampleEntries[0]?.member.user.username ?? 'username')
    .replace(/{display_name}/g, sampleEntries[0]?.member.displayName ?? 'display_name')
    .replace(/{server_name}/g, successGuilds[0]?.guildName ?? 'Old Server')
    .replace(/{invite_link}/g, preset.invite_link);

  const sampleText = sampleEntries.length > 0
    ? sampleEntries.map((e) => `\`${e.member.user.username}\``).join(', ')
    : '_None_';

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Dry Run — Preset: \`${presetName}\``)
    .setColor(0xfee75c)
    .setDescription('_No messages have been sent. This is a preview only._')
    .addFields(
      {
        name: `📡 Source Servers (${sourceGuildIds.length})`,
        value: guildSummary.slice(0, 1024),
        inline: false,
      },
      {
        name: '📊 Breakdown',
        value: [
          `🤖 Bots skipped: **${totalBots}**`,
          `⏭️ Already invited: **${totalAlreadyInvited}**`,
          filterByRoles ? `🚫 Missing role: **${totalRoleFiltered}**` : null,
          `✉️ Would receive DM: **${totalEligible}**`,
        ].filter(Boolean).join('\n'),
        inline: false,
      },
      {
        name: '🎭 Role Filter',
        value: filterByRoles ? roleIds.map((r) => `<@&${r}>`).join(', ') : 'None — all human members',
        inline: true,
      },
      {
        name: '⏱️ Estimated Time',
        value: `${estimatedTime} at ${dmDelay}ms/DM`,
        inline: true,
      },
      {
        name: `📋 Sample Recipients (${Math.min(sampleSize, totalEligible)} of ${totalEligible})`,
        value: sampleText.slice(0, 1024),
        inline: false,
      },
      {
        name: '💬 Message Preview',
        value: `\`\`\`${messagePreview.slice(0, 900)}\`\`\``,
        inline: false,
      }
    )
    .setFooter({
      text: totalEligible > 0
        ? `Run /invite start preset:${presetName} to send for real`
        : "No members would be DM'd — check your role filter or clear the log",
    });

  await interaction.editReply({ embeds: [embed] });
  log.info(`Dry run: ${totalEligible} would receive DM across ${successGuilds.length} guild(s), ${totalAlreadyInvited} already invited`);
}
