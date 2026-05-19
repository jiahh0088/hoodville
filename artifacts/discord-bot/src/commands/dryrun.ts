import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { presetRepo, inviteLogRepo } from '../db/database';
import { log } from '../logger';

export const data = new SlashCommandBuilder()
  .setName('dryrun')
  .setDescription('Preview exactly who would be DM\'d by a campaign — no messages sent')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) =>
    o
      .setName('preset')
      .setDescription('Preset to simulate')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((o) =>
    o
      .setName('source_guild')
      .setDescription('Old server ID (defaults to OLD_GUILD_ID env var)')
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

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const presetName = interaction.options.getString('preset', true);
  const sourceGuildId =
    interaction.options.getString('source_guild') ?? process.env.OLD_GUILD_ID ?? '';
  const sampleSize = interaction.options.getInteger('sample_size') ?? 10;

  if (!sourceGuildId) {
    await interaction.editReply('❌ No source guild specified and `OLD_GUILD_ID` env var is not set.');
    return;
  }

  const preset = presetRepo.get(presetName);
  if (!preset) {
    await interaction.editReply(`❌ No preset named \`${presetName}\` found. Use \`/preset list\` to see available presets.`);
    return;
  }

  const oldGuild = interaction.client.guilds.cache.get(sourceGuildId);
  if (!oldGuild) {
    await interaction.editReply(
      `❌ Bot is not in the server with ID \`${sourceGuildId}\`. Make sure the bot is invited to your old server.`
    );
    return;
  }

  log.info(`Dry run started by ${interaction.user.tag} for preset: ${presetName} on guild: ${oldGuild.name}`);

  let allMembers;
  try {
    allMembers = await oldGuild.members.fetch();
  } catch (err) {
    await interaction.editReply(
      `❌ Failed to fetch members. Ensure **Server Members Intent** is enabled in the Discord developer portal.\n\`${err}\``
    );
    return;
  }

  const roleIds: string[] = JSON.parse(preset.role_ids);
  const filterByRoles = roleIds.length > 0;

  const bots = allMembers.filter((m) => m.user.bot);
  const humans = allMembers.filter((m) => !m.user.bot);

  const alreadyInvited = humans.filter((m) =>
    inviteLogRepo.hasBeenInvited(m.user.id, sourceGuildId)
  );

  const roleFiltered = filterByRoles
    ? humans.filter((m) => !m.user.bot && !inviteLogRepo.hasBeenInvited(m.user.id, sourceGuildId) && !roleIds.some((rid) => m.roles.cache.has(rid)))
    : humans.filter(() => false);

  const willReceiveDM = humans.filter((m) => {
    if (inviteLogRepo.hasBeenInvited(m.user.id, sourceGuildId)) return false;
    if (filterByRoles && !roleIds.some((rid) => m.roles.cache.has(rid))) return false;
    return true;
  });

  const sampleMembers = Array.from(willReceiveDM.values()).slice(0, sampleSize);
  const sampleText = sampleMembers.length > 0
    ? sampleMembers.map((m) => `\`${m.user.username}\``).join(', ')
    : '_None_';

  const dmDelay = parseInt(process.env.DM_DELAY_MS ?? '1500', 10);
  const estimatedSeconds = Math.ceil((willReceiveDM.size * dmDelay) / 1000);
  const estimatedTime =
    estimatedSeconds < 60
      ? `~${estimatedSeconds}s`
      : `~${Math.ceil(estimatedSeconds / 60)}m ${estimatedSeconds % 60}s`;

  const messagePreview = preset.message_template
    .replace(/{username}/g, sampleMembers[0]?.user.username ?? 'username')
    .replace(/{display_name}/g, sampleMembers[0]?.displayName ?? 'display_name')
    .replace(/{server_name}/g, oldGuild.name)
    .replace(/{invite_link}/g, preset.invite_link);

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Dry Run — Preset: \`${presetName}\``)
    .setColor(0xfee75c)
    .setDescription(`**Server:** ${oldGuild.name} (\`${sourceGuildId}\`)\n_No messages have been sent. This is a preview only._`)
    .addFields(
      {
        name: '📊 Breakdown',
        value: [
          `👥 **Total members:** ${allMembers.size}`,
          `🤖 **Bots (skipped):** ${bots.size}`,
          `⏭️ **Already invited (skipped):** ${alreadyInvited.size}`,
          filterByRoles ? `🚫 **Missing required role (skipped):** ${roleFiltered.size}` : null,
          `✉️ **Would receive DM:** ${willReceiveDM.size}`,
        ].filter(Boolean).join('\n'),
        inline: false,
      },
      {
        name: '🎭 Role Filter',
        value: filterByRoles
          ? roleIds.map((r) => `<@&${r}>`).join(', ')
          : 'None — all human members',
        inline: true,
      },
      {
        name: '⏱️ Estimated Time',
        value: `${estimatedTime} at ${dmDelay}ms/DM`,
        inline: true,
      },
      {
        name: `📋 Sample Recipients (${Math.min(sampleSize, willReceiveDM.size)} of ${willReceiveDM.size})`,
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
      text: willReceiveDM.size > 0
        ? `Run /invite start preset:${presetName} to send for real`
        : 'No members would be DM\'d — check your role filter or clear the invite log',
    });

  await interaction.editReply({ embeds: [embed] });
  log.info(`Dry run complete: ${willReceiveDM.size} would receive DM, ${alreadyInvited.size} already invited`);
}
