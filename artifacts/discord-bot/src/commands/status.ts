import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { campaignRepo, inviteLogRepo } from '../db/database';

export const data = new SlashCommandBuilder()
  .setName('logstats')
  .setDescription('Show detailed invite log statistics')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) =>
    o
      .setName('source_guild')
      .setDescription('Guild ID (defaults to OLD_GUILD_ID env var)')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sourceGuildId =
    interaction.options.getString('source_guild') ?? process.env.OLD_GUILD_ID ?? '';

  if (!sourceGuildId) {
    await interaction.reply({ content: '❌ No source guild specified and `OLD_GUILD_ID` env var is not set.', ephemeral: true });
    return;
  }

  const stats = inviteLogRepo.getStats(sourceGuildId);
  const latest = campaignRepo.getLatest(sourceGuildId);

  const embed = new EmbedBuilder()
    .setTitle('📊 Invite Log Statistics')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Source Guild', value: `\`${sourceGuildId}\``, inline: false },
      { name: 'Total Logged', value: String(stats.total), inline: true },
      { name: '✅ Sent', value: String(stats.sent), inline: true },
      { name: '❌ Failed', value: String(stats.failed), inline: true }
    );

  if (latest) {
    embed.addFields(
      { name: '\u200B', value: '**Last Campaign**', inline: false },
      { name: 'Preset', value: latest.preset_name, inline: true },
      { name: 'Status', value: latest.status, inline: true },
      { name: 'Started', value: `<t:${Math.floor(new Date(latest.started_at).getTime() / 1000)}:R>`, inline: true },
      { name: 'Sent', value: String(latest.total_sent), inline: true },
      { name: 'Failed', value: String(latest.total_failed), inline: true },
      { name: 'Skipped', value: String(latest.total_skipped), inline: true }
    );
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
