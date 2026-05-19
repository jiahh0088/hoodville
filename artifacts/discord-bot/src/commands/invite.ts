import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { presetRepo, inviteLogRepo } from '../db/database';
import {
  isCampaignRunning,
  cancelActiveCampaign,
  getActiveCampaignStats,
  runInviteCampaign,
} from '../handlers/inviteHandler';
import { log } from '../logger';

export const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Run invite campaigns to move members to your new server')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Start sending invites using a preset')
      .addStringOption((o) =>
        o.setName('preset').setDescription('Name of the preset to use').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName('source_guild')
          .setDescription('Old server ID to pull members from (defaults to OLD_GUILD_ID env var)')
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('Stop the currently running invite campaign')
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Check the status of the current or most recent campaign')
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear_log')
      .setDescription('Clear the invite log for a guild (allows re-inviting everyone)')
      .addStringOption((o) =>
        o
          .setName('source_guild')
          .setDescription('Guild ID to clear log for (defaults to OLD_GUILD_ID env var)')
          .setRequired(false)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    if (isCampaignRunning()) {
      await interaction.reply({
        content: '⚠️ A campaign is already running. Use `/invite stop` to cancel it first, or `/invite status` to check progress.',
        ephemeral: true,
      });
      return;
    }

    const presetName = interaction.options.getString('preset', true);
    const sourceGuildId =
      interaction.options.getString('source_guild') ?? process.env.OLD_GUILD_ID ?? '';

    if (!sourceGuildId) {
      await interaction.reply({
        content: '❌ No source guild specified and `OLD_GUILD_ID` env var is not set.',
        ephemeral: true,
      });
      return;
    }

    const preset = presetRepo.get(presetName);
    if (!preset) {
      await interaction.reply({
        content: `❌ No preset named \`${presetName}\` found. Use \`/preset list\` to see available presets.`,
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.channel as TextChannel;

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🚀 Starting Invite Campaign')
          .setColor(0x57f287)
          .addFields(
            { name: 'Preset', value: presetName, inline: true },
            { name: 'Source Guild', value: sourceGuildId, inline: true },
            { name: 'Invite Link', value: preset.invite_link, inline: false }
          )
          .setDescription('Fetching members... A live status message will appear below.'),
      ],
    });

    log.info(`Campaign started by ${interaction.user.tag} using preset: ${presetName}`);

    runInviteCampaign(
      interaction.client,
      preset,
      sourceGuildId,
      interaction.user.id,
      channel
    ).catch(async (err: Error) => {
      log.error(`Campaign error: ${err.message}`);
      try {
        await channel.send(`❌ **Campaign Error:** ${err.message}`);
      } catch { /* ignore */ }
    });

    return;
  }

  if (sub === 'stop') {
    if (!isCampaignRunning()) {
      await interaction.reply({ content: '⚠️ No campaign is currently running.', ephemeral: true });
      return;
    }
    cancelActiveCampaign();
    log.info(`Campaign cancelled by ${interaction.user.tag}`);
    await interaction.reply({ content: '🛑 Campaign cancellation requested. The current DM will finish, then it will stop.', ephemeral: true });
    return;
  }

  if (sub === 'status') {
    const stats = getActiveCampaignStats();

    if (stats && !stats.cancelled) {
      const pct = stats.total > 0
        ? Math.round(((stats.sent + stats.failed) / stats.total) * 100)
        : 0;

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📊 Campaign Status — Running')
            .setColor(0xfee75c)
            .addFields(
              { name: 'Total Eligible', value: String(stats.total), inline: true },
              { name: 'Sent', value: String(stats.sent), inline: true },
              { name: 'Failed (DMs closed)', value: String(stats.failed), inline: true },
              { name: 'Progress', value: `${pct}%`, inline: true }
            ),
        ],
        ephemeral: true,
      });
      return;
    }

    const sourceGuildId =
      interaction.options.getString('source_guild') ?? process.env.OLD_GUILD_ID ?? '';
    const globalStats = sourceGuildId
      ? inviteLogRepo.getStats(sourceGuildId)
      : { total: 0, sent: 0, failed: 0 };

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📊 Invite Log Stats')
          .setColor(0x5865f2)
          .setDescription(sourceGuildId ? `Source guild: \`${sourceGuildId}\`` : '_No source guild specified_')
          .addFields(
            { name: 'Total Logged', value: String(globalStats.total), inline: true },
            { name: 'Successfully Sent', value: String(globalStats.sent), inline: true },
            { name: 'Failed', value: String(globalStats.failed), inline: true }
          )
          .setFooter({ text: 'No campaign is currently running' }),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'clear_log') {
    const sourceGuildId =
      interaction.options.getString('source_guild') ?? process.env.OLD_GUILD_ID ?? '';

    if (!sourceGuildId) {
      await interaction.reply({ content: '❌ No source guild specified and `OLD_GUILD_ID` env var is not set.', ephemeral: true });
      return;
    }

    const removed = inviteLogRepo.clearLog(sourceGuildId);
    log.info(`Invite log cleared for guild ${sourceGuildId} by ${interaction.user.tag}: ${removed} entries removed`);
    await interaction.reply({
      content: `🗑️ Invite log cleared for guild \`${sourceGuildId}\`. **${removed}** entries removed. Everyone in that server can be invited again.`,
      ephemeral: true,
    });
    return;
  }
}
