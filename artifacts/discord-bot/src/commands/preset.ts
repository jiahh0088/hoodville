import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { presetRepo } from '../db/database';
import { log } from '../logger';

export const data = new SlashCommandBuilder()
  .setName('preset')
  .setDescription('Manage invite presets')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a new invite preset')
      .addStringOption((o) =>
        o.setName('name').setDescription('Preset name (no spaces)').setRequired(true)
      )
      .addStringOption((o) =>
        o.setName('invite_link').setDescription('The invite link to the NEW server').setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName('message')
          .setDescription(
            'DM message template. Use {username}, {server_name}, {invite_link}'
          )
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName('roles')
          .setDescription(
            'Comma-separated role IDs to target (leave blank = all members). e.g. 123,456'
          )
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('List all saved presets')
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('View details of a specific preset')
      .addStringOption((o) =>
        o.setName('name').setDescription('Preset name').setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Edit an existing preset')
      .addStringOption((o) =>
        o.setName('name').setDescription('Preset to edit').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((o) =>
        o.setName('invite_link').setDescription('New invite link').setRequired(false)
      )
      .addStringOption((o) =>
        o.setName('message').setDescription('New message template').setRequired(false)
      )
      .addStringOption((o) =>
        o.setName('roles').setDescription('New comma-separated role IDs (use "none" to clear)').setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Delete a preset')
      .addStringOption((o) =>
        o.setName('name').setDescription('Preset name').setRequired(true).setAutocomplete(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const name = interaction.options.getString('name', true).trim().replace(/\s+/g, '-');
    const inviteLink = interaction.options.getString('invite_link', true).trim();
    const message = interaction.options.getString('message', true);
    const rolesRaw = interaction.options.getString('roles') ?? '';
    const roleIds = rolesRaw
      ? rolesRaw.split(',').map((r) => r.trim()).filter(Boolean)
      : [];

    if (presetRepo.get(name)) {
      await interaction.reply({ content: `❌ A preset named \`${name}\` already exists. Use \`/preset edit\` to modify it.`, ephemeral: true });
      return;
    }

    const preset = presetRepo.create(name, inviteLink, roleIds, message);
    log.info(`Preset created: ${name} by ${interaction.user.tag}`);

    const embed = new EmbedBuilder()
      .setTitle(`✅ Preset Created: ${preset.name}`)
      .setColor(0x57f287)
      .addFields(
        { name: 'Invite Link', value: inviteLink, inline: false },
        { name: 'Role Filter', value: roleIds.length ? roleIds.map((r) => `<@&${r}>`).join(', ') : 'All members', inline: true },
        { name: 'Message Preview', value: `\`\`\`${message.slice(0, 400)}\`\`\``, inline: false }
      )
      .setFooter({ text: `Use /invite start preset:${name} to launch a campaign` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'list') {
    const presets = presetRepo.list();
    if (presets.length === 0) {
      await interaction.reply({ content: '📭 No presets found. Use `/preset create` to make one.', ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Invite Presets')
      .setColor(0x5865f2)
      .setDescription(
        presets
          .map((p) => {
            const roles: string[] = JSON.parse(p.role_ids);
            return `**\`${p.name}\`** — ${roles.length ? `Roles: ${roles.length}` : 'All members'} | Created: <t:${Math.floor(new Date(p.created_at).getTime() / 1000)}:R>`;
          })
          .join('\n')
      )
      .setFooter({ text: `${presets.length} preset(s) saved` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'view') {
    const name = interaction.options.getString('name', true);
    const preset = presetRepo.get(name);
    if (!preset) {
      await interaction.reply({ content: `❌ No preset named \`${name}\` found.`, ephemeral: true });
      return;
    }

    const roleIds: string[] = JSON.parse(preset.role_ids);
    const embed = new EmbedBuilder()
      .setTitle(`🔍 Preset: ${preset.name}`)
      .setColor(0xfee75c)
      .addFields(
        { name: 'Invite Link', value: preset.invite_link, inline: false },
        { name: 'Role Filter', value: roleIds.length ? roleIds.map((r) => `<@&${r}>`).join(', ') : 'All members', inline: true },
        { name: 'Created', value: `<t:${Math.floor(new Date(preset.created_at).getTime() / 1000)}:f>`, inline: true },
        { name: 'Message Template', value: `\`\`\`${preset.message_template.slice(0, 900)}\`\`\``, inline: false }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'edit') {
    const name = interaction.options.getString('name', true);
    const preset = presetRepo.get(name);
    if (!preset) {
      await interaction.reply({ content: `❌ No preset named \`${name}\` found.`, ephemeral: true });
      return;
    }

    const newLink = interaction.options.getString('invite_link') ?? undefined;
    const newMsg  = interaction.options.getString('message') ?? undefined;
    const rolesRaw = interaction.options.getString('roles') ?? undefined;

    const updates: Parameters<typeof presetRepo.update>[1] = {};
    if (newLink) updates.invite_link = newLink;
    if (newMsg)  updates.message_template = newMsg;
    if (rolesRaw !== undefined) {
      updates.role_ids = rolesRaw.toLowerCase() === 'none'
        ? JSON.stringify([])
        : JSON.stringify(rolesRaw.split(',').map((r) => r.trim()).filter(Boolean));
    }

    presetRepo.update(name, updates);
    log.info(`Preset edited: ${name} by ${interaction.user.tag}`);
    await interaction.reply({ content: `✅ Preset \`${name}\` updated.`, ephemeral: true });
    return;
  }

  if (sub === 'delete') {
    const name = interaction.options.getString('name', true);
    const deleted = presetRepo.delete(name);
    if (!deleted) {
      await interaction.reply({ content: `❌ No preset named \`${name}\` found.`, ephemeral: true });
      return;
    }
    log.info(`Preset deleted: ${name} by ${interaction.user.tag}`);
    await interaction.reply({ content: `🗑️ Preset \`${name}\` deleted.`, ephemeral: true });
    return;
  }
}
