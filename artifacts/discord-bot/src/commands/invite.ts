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
        o
          .setName('preset')
          .setDescription('Preset to use (contains the invite link to the new server)')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName('source_guilds')
          .setDescription('Old server ID(s) to pull from — comma-separated, up to 10 (e.g. 123,456,789)')
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('Stop the currently running invite campaign')
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Check the status of the current or most recent campaign')
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear_log')
      .setDescription('Clear the invite log (allows re-inviting everyone)')
      .addStringOption((o) =>
        o
          .setName('source_guilds')
          .setDescription('Server ID(s) to clear — comma-separated (defaults to OLD_GUILD_ID env var)')
          .setRequired(false)
      )
  );

function parseGuildIds(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    if (isCampaignRunning()) {
      await interaction.reply({
        content: '⚠️ A campaign is already running. Use `/invite stop` to cancel it first.',
        ephemeral: true,
      });
      return;
    }

    const presetName = interaction.options.getString('preset', true);
    const rawGuilds = interaction.options.getString('source_guilds') ?? process.env.OLD_GUILD_ID ?? '';

    if (!rawGuilds) {
      await interaction.reply({
        content: '❌ No source guild(s) specified and `OLD_GUILD_ID` env var is not set.',
        ephemeral: true,
      });
      return;
    }

    const sourceGuildIds = parseGuildIds(rawGuilds);
    if (sourceGuildIds.length === 0) {
      await interaction.reply({ content: '❌ Could not parse any valid guild IDs.', ephemeral: true });
      return;
    }
    if (sourceGuildIds.length > 10) {
      await interaction.reply({ content: '❌ Maximum 10 source servers allowed at once.', ephemeral: true });
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
    const guildList = sourceGuildIds.map((id) => {
      const name = interaction.client.guilds.cache.get(id)?.name;
      return name ? `**${name}** (\`${id}\`)` : `\`${id}\``;
    }).join('\n');

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🚀 Starting Invite Campaign')
          .setColor(0x57f287)
          .addFields(
            { name: 'Preset', value: presetName, inline: true },
            { name: 'Source Servers', value: String(sourceGuildIds.length), inline: true },
            { name: 'Invite Link', value: preset.invite_link, inline: false },
            { name: `Source Server${sourceGuildIds.length > 1 ? 's' : ''}`, value: guildList, inline: false }
          )
          .setDescription('Fetching members from all source servers in parallel... A live status message will appear below.'),
      ],
    });

    log.info(`Campaign started by ${interaction.user.tag} — preset: ${presetName}, guilds: ${sourceGuildIds.join(', ')}`);

    runInviteCampaign(
      interaction.client,
      preset,
      sourceGuildIds,
      interaction.user.id,
      channel
    ).catch(async (err: Error) => {
      log.error(`Campaign error: ${err.message}`);
      try { await channel.send(`❌ **Campaign Error:** ${err.message}`); } catch { /* ignore */ }
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
    await interaction.reply({ content: '🛑 Cancellation requested. The current DM will finish, then it will stop.', ephemeral: true });
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
              { name: 'Source Servers', value: String(stats.sourceGuildCount), inline: true },
              { name: 'Unique Eligible', value: String(stats.total), inline: true },
              { name: 'Already Invited', value: String(stats.skipped), inline: true },
              { name: 'Sent', value: String(stats.sent), inline: true },
              { name: 'Failed (DMs closed)', value: String(stats.failed), inline: true },
              { name: 'Progress', value: `${pct}%`, inline: true }
            ),
        ],
        ephemeral: true,
      });
      return;
    }

    const rawGuilds = process.env.OLD_GUILD_ID ?? '';
    const guildIds = rawGuilds ? parseGuildIds(rawGuilds) : [];

    if (guildIds.length === 0) {
      await interaction.reply({ content: '⚠️ No campaign running and no `OLD_GUILD_ID` set to show stats for.', ephemeral: true });
      return;
    }

    const combined = guildIds.reduce(
      (acc, id) => {
        const s = inviteLogRepo.getStats(id);
        return { total: acc.total + s.total, sent: acc.sent + s.sent, failed: acc.failed + s.failed };
      },
      { total: 0, sent: 0, failed: 0 }
    );

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📊 Invite Log Stats')
          .setColor(0x5865f2)
          .addFields(
            { name: 'Total Logged', value: String(combined.total), inline: true },
            { name: '✅ Sent', value: String(combined.sent), inline: true },
            { name: '❌ Failed', value: String(combined.failed), inline: true }
          )
          .setFooter({ text: 'No campaign is currently running' }),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'clear_log') {
    const rawGuilds = interaction.options.getString('source_guilds') ?? process.env.OLD_GUILD_ID ?? '';
    if (!rawGuilds) {
      await interaction.reply({ content: '❌ No source guild(s) specified and `OLD_GUILD_ID` env var is not set.', ephemeral: true });
      return;
    }

    const guildIds = parseGuildIds(rawGuilds);
    let totalRemoved = 0;
    for (const id of guildIds) {
      totalRemoved += inviteLogRepo.clearLog(id);
    }

    log.info(`Invite log cleared for ${guildIds.length} guild(s) by ${interaction.user.tag}: ${totalRemoved} entries removed`);
    await interaction.reply({
      content: `🗑️ Cleared invite log for **${guildIds.length}** server(s). **${totalRemoved}** entries removed — everyone can be re-invited.`,
      ephemeral: true,
    });
    return;
  }
}
