require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const modeChoices = [
  { name: 'Button (animated join button)', value: 'button' },
  { name: 'Text command (/enter)', value: 'text' }
];

const commands = [
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Create a timed giveaway')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('prize').setDescription('Prize name').setRequired(true).setMaxLength(200))
    .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 1d (max 30d)').setRequired(true).setMaxLength(20))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20))
    .addStringOption(o => o.setName('condition').setDescription('Optional condition / winner instruction').setRequired(false).setMaxLength(500))
    .addStringOption(o => o.setName('entry_text').setDescription('Exact text users must type (text mode only)').setRequired(false).setMaxLength(200))
    .addStringOption(o => o.setName('sponsor_url').setDescription('Optional sponsor server invite URL').setRequired(false).setMaxLength(500))
    .addStringOption(o => o.setName('mode').setDescription('Button or text entry').setRequired(false).addChoices(...modeChoices)),
  new SlashCommandBuilder()
    .setName('drop')
    .setDescription('Create a first-come claim drop')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('prize').setDescription('Prize name').setRequired(true).setMaxLength(200))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of first claimers who win').setRequired(true).setMinValue(1).setMaxValue(20))
    .addStringOption(o => o.setName('condition').setDescription('Optional winner instruction').setRequired(false).setMaxLength(500))
    .addStringOption(o => o.setName('entry_text').setDescription('Exact text users must type (text mode only)').setRequired(false).setMaxLength(200))
    .addStringOption(o => o.setName('sponsor_url').setDescription('Optional sponsor server invite URL').setRequired(false).setMaxLength(500))
    .addStringOption(o => o.setName('mode').setDescription('Button or text entry').setRequired(false).addChoices(...modeChoices)),
  new SlashCommandBuilder()
    .setName('reroll')
    .setDescription('Choose replacement winners for a finished giveaway')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('message_id').setDescription('ID of the giveaway message').setRequired(true).setMaxLength(25))
    .addIntegerOption(o => o.setName('winners').setDescription('How many replacement winners (default: original count)').setRequired(false).setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder()
    .setName('enter')
    .setDescription('Enter a text-mode giveaway or claim a text-mode drop')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway/drop message ID').setRequired(true).setMaxLength(25)),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave a text-mode giveaway')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true).setMaxLength(25)),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show private instructions for the giveaway bot')
].map(c => c.toJSON());

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  if (!token || !clientId) throw new Error('Set DISCORD_TOKEN and CLIENT_ID in .env');
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log(`Registered ${commands.length} GLOBAL commands (may take time to appear in every server)`);
}
main().catch(err => { console.error(err); process.exit(1); });
