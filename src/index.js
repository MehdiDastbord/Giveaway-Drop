require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const ms = require('ms');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DB_PATH = process.env.DATABASE_PATH || './data/giveaways.sqlite';
const JOIN_EMOJI = '<a:giveaway:1558889317403860992>';
const MAX_DURATION = 30 * 24 * 60 * 60 * 1000;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID. Copy .env.example to .env and configure it.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS events (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('giveaway','drop')),
  prize TEXT NOT NULL,
  condition_text TEXT,
  entry_text TEXT,
  sponsor_url TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('button','text')),
  winner_count INTEGER NOT NULL,
  ends_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active','ended')),
  created_at INTEGER NOT NULL,
  winners_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS entries (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entered_at INTEGER NOT NULL,
  PRIMARY KEY(message_id, user_id),
  FOREIGN KEY(message_id) REFERENCES events(message_id) ON DELETE CASCADE
);
`);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// Safe schema migration for databases created by an earlier version.
try { db.exec('ALTER TABLE events ADD COLUMN entry_text TEXT'); } catch (err) {
  if (!String(err.message).includes('duplicate column name')) throw err;
}

const q = {
  insertEvent: db.prepare(`INSERT INTO events
    (message_id,guild_id,channel_id,host_id,kind,prize,condition_text,entry_text,sponsor_url,mode,winner_count,ends_at,status,created_at)
    VALUES (@message_id,@guild_id,@channel_id,@host_id,@kind,@prize,@condition_text,@entry_text,@sponsor_url,@mode,@winner_count,@ends_at,@status,@created_at)`),
  getEvent: db.prepare('SELECT * FROM events WHERE message_id=?'),
  active: db.prepare("SELECT * FROM events WHERE status='active'"),
  endEvent: db.prepare("UPDATE events SET status='ended', winners_json=? WHERE message_id=?"),
  entryCount: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE message_id=?'),
  hasEntry: db.prepare('SELECT 1 FROM entries WHERE message_id=? AND user_id=?'),
  addEntry: db.prepare('INSERT OR IGNORE INTO entries(message_id,user_id,entered_at) VALUES(?,?,?)'),
  removeEntry: db.prepare('DELETE FROM entries WHERE message_id=? AND user_id=?'),
  entrants: db.prepare('SELECT user_id FROM entries WHERE message_id=? ORDER BY entered_at ASC'),
  updateWinners: db.prepare('UPDATE events SET winners_json=? WHERE message_id=?')
};

function parseDuration(input) {
  const value = ms(input);
  if (!Number.isFinite(value) || value < 10_000 || value > MAX_DURATION) return null;
  return value;
}
function validUrl(input) {
  if (!input) return null;
  try {
    const u = new URL(input);
    return ['https:', 'http:'].includes(u.protocol) ? u.toString() : null;
  } catch { return null; }
}
function countOf(id) { return q.entryCount.get(id).n; }
function makeEmbed(ev, count, ended = false, winners = []) {
  const isDrop = ev.kind === 'drop';
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x5865F2 : 0xED4245)
    .setTitle(isDrop ? '🎁 DROP' : '🎉 GIVEAWAY')
    .setDescription(`**Prize:** ${ev.prize}\n\n${ev.condition_text ? `**Condition:** ${ev.condition_text}` : '💖 بدون شرط، عشق کنید!'}\n\n**Entrants:** ${count}\n**Winners:** ${ev.winner_count}${ev.mode === 'text' && ev.entry_text ? `\n**Required text:** ${ev.entry_text}` : ''}\n${isDrop ? (ev.entry_text ? `**Drop rule:** First ${ev.winner_count} users to type: ${ev.entry_text}` : '**Type:** First-come, first-served') : `**Ends:** <t:${Math.floor(ev.ends_at / 1000)}:R> · <t:${Math.floor(ev.ends_at / 1000)}:F>`}${ended ? '\n\n**Status:** Ended' : ''}${winners.length ? `\n**Selected:** ${winners.map(id => `<@${id}>`).join(', ')}` : ''}`)
    .setFooter({ text: 'Mehdi • itskingpubgyt' })
    .setTimestamp(new Date(ev.created_at));
  if (ev.sponsor_url) embed.addFields({ name: 'Sponsor server', value: 'Use the **Sponsor Server** button to open the invite.' });
  return embed;
}
function components(ev, count, disabled = false, includeSponsor = true) {
  const rows = [];
  if (ev.mode === 'button' && !disabled) {
    const join = new ButtonBuilder()
      .setCustomId(`gw:join:${ev.message_id}`)
      .setStyle(ButtonStyle.Success)
      .setLabel(String(count))
      .setEmoji({ id: '1558889317403860992', name: 'giveaway', animated: true });
    const row = new ActionRowBuilder().addComponents(join);
    if (includeSponsor && ev.sponsor_url) {
      row.addComponents(new ButtonBuilder().setLabel('Sponsor Server').setStyle(ButtonStyle.Link).setURL(ev.sponsor_url));
    }
    rows.push(row);
  } else if (ev.mode === 'button' && disabled) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gw:closed:${ev.message_id}`).setStyle(ButtonStyle.Secondary).setLabel(`Ended • ${count} entries`).setDisabled(true)
    );
    if (includeSponsor && ev.sponsor_url) row.addComponents(new ButtonBuilder().setLabel('Sponsor Server').setStyle(ButtonStyle.Link).setURL(ev.sponsor_url));
    rows.push(row);
  } else if (includeSponsor && ev.sponsor_url) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Sponsor Server').setStyle(ButtonStyle.Link).setURL(ev.sponsor_url)
    ));
  }
  return rows;
}
async function fetchMessage(ev) {
  const channel = await client.channels.fetch(ev.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  const message = await channel.messages.fetch(ev.message_id).catch(() => null);
  return message ? { channel, message } : null;
}
async function refreshMessage(ev, ended = false, winners = []) {
  const found = await fetchMessage(ev);
  if (!found) return;
  const count = countOf(ev.message_id);
  await found.message.edit({
    embeds: [makeEmbed(ev, count, ended, winners)],
    components: components(ev, count, ended, !ended)
  }).catch(err => console.error('Could not update giveaway message:', err.message));
}
function sampleUnique(arr, n) {
  const pool = [...arr];
  const result = [];
  while (pool.length && result.length < n) {
    const i = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(i, 1)[0]);
  }
  return result;
}
async function announceEnd(ev, winnerIds) {
  await refreshMessage(ev, true, winnerIds);
  const found = await fetchMessage(ev);
  if (!found) return;
  const winnerText = winnerIds.length ? winnerIds.map(id => `<@${id}>`).join(', ') : 'هیچ‌کس وارد نشد؛ برنده‌ای انتخاب نشد.';
  const instruction = ev.condition_text
    ? `مبارکه! ${winnerIds.map(id => `<@${id}>`).join(' ')} در سرور اسپانسر تیکت بدید.\n**شرط/راهنما:** ${ev.condition_text}`
    : `مبارکه! ${winnerIds.map(id => `<@${id}>`).join(' ')} تیکت بدید.`;
  await found.channel.send({
    content: `🎉 **${ev.kind === 'drop' ? 'Drop' : 'Giveaway'} تمام شد!**\n**Prize:** ${ev.prize}\n**Winners:** ${winnerText}\n${winnerIds.length ? instruction : ''}`,
    allowedMentions: { users: winnerIds }
  }).catch(err => console.error('Could not announce winners:', err.message));
}
async function finishGiveaway(ev) {
  const current = q.getEvent.get(ev.message_id);
  if (!current || current.status !== 'active') return;
  const entries = q.entrants.all(ev.message_id).map(x => x.user_id);
  const winners = sampleUnique(entries, current.winner_count);
  q.endEvent.run(JSON.stringify(winners), ev.message_id);
  await announceEnd(current, winners);
}
async function finishDrop(ev) {
  const current = q.getEvent.get(ev.message_id);
  if (!current || current.status !== 'active') return;
  const winners = q.entrants.all(ev.message_id).slice(0, current.winner_count).map(x => x.user_id);
  q.endEvent.run(JSON.stringify(winners), ev.message_id);
  await announceEnd(current, winners);
}
async function endDueEvents() {
  const now = Date.now();
  for (const ev of q.active.all()) {
    if (ev.kind === 'giveaway' && ev.ends_at <= now) await finishGiveaway(ev);
  }
}
setInterval(() => endDueEvents().catch(console.error), 500);

async function createEvent(interaction, kind) {
  const prize = interaction.options.getString('prize', true).trim();
  const condition = interaction.options.getString('condition')?.trim() || null;
  const entryText = interaction.options.getString('entry_text')?.trim() || null;
  const sponsorInput = interaction.options.getString('sponsor_url');
  const sponsor = validUrl(sponsorInput);
  if (sponsorInput && !sponsor) {
    return interaction.reply({ content: 'لینک اسپانسر معتبر نیست. فقط لینک کامل http:// یا https:// بفرست.', ephemeral: true });
  }
  const mode = interaction.options.getString('mode') || 'button';
  if (mode === 'text' && !entryText) return interaction.reply({ content: 'برای حالت text باید گزینه entry_text را پر کنی؛ مثلاً: من برنده‌ام', ephemeral: true });
  const winners = interaction.options.getInteger('winners', true);
  let endsAt = null;
  if (kind === 'giveaway') {
    const durationRaw = interaction.options.getString('duration', true);
    const duration = parseDuration(durationRaw);
    if (!duration) return interaction.reply({ content: 'مدت نامعتبر است. از 10s تا 30d استفاده کن؛ مثل 30m یا 2h.', ephemeral: true });
    endsAt = Date.now() + duration;
  }
  await interaction.deferReply({ ephemeral: true });
  const ev = {
    message_id: '',
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    host_id: interaction.user.id,
    kind, prize, condition_text: condition, entry_text: entryText, sponsor_url: sponsor, mode,
    winner_count: winners, ends_at: endsAt, status: 'active', created_at: Date.now()
  };
  const initialEmbed = makeEmbed(ev, 0);
  const message = await interaction.channel.send({
    embeds: [initialEmbed],
    components: [],
    allowedMentions: { parse: [] }
  });
  ev.message_id = message.id;
  q.insertEvent.run(ev);
  await message.edit({ embeds: [makeEmbed(ev, 0)], components: components(ev, 0, false) });
  await interaction.editReply({ content: `${kind === 'giveaway' ? 'Giveaway' : 'Drop'} ساخته شد. Message ID: \`${message.id}\`` });
  if (kind === 'drop' && winners === 0) return;
  if (kind === 'drop') {
    // A drop closes as soon as its configured number of first claimers has been reached.
    // If fewer people claim, it remains open until manually resolved or process restart.
  }
}
async function handleEntry(interaction, eventId, action = 'join') {
  const ev = q.getEvent.get(eventId);
  if (!ev) return interaction.reply({
    content: 'این رویداد در دیتابیس فعلی پیدا نشد. اگر بات پس از ساخت رویداد ری‌استارت یا دیپلوی شده، DATABASE_PATH را به فایل دیتابیس پایدار قبلی تنظیم کن؛ در غیر این صورت رویداد را دوباره بساز.',
    ephemeral: true
  });
  if (ev.guild_id !== interaction.guildId || ev.channel_id !== interaction.channelId ||
      (interaction.isButton() && interaction.message.id !== ev.message_id)) {
    return interaction.reply({ content: 'این دکمه متعلق به همین پیام و کانال نیست.', ephemeral: true });
  }
  if (ev.status !== 'active' || (ev.kind === 'giveaway' && Date.now() >= ev.ends_at)) {
    if (ev.status === 'active' && ev.kind === 'giveaway') await finishGiveaway(ev);
    return interaction.reply({ content: 'این رویداد تمام شده و ورود جدید پذیرفته نمی‌شود.', ephemeral: true });
  }
  const exists = !!q.hasEntry.get(eventId, interaction.user.id);
  if (action === 'leave') {
    if (!exists) return interaction.reply({ content: 'شما قبلاً وارد این رویداد نشده‌اید.', ephemeral: true });
    q.removeEntry.run(eventId, interaction.user.id);
    await refreshMessage(ev);
    return interaction.reply({ content: 'از رویداد خارج شدی.', ephemeral: true });
  }
  if (exists) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gw:leave:${eventId}`).setLabel('Leave').setStyle(ButtonStyle.Danger)
    );
    return interaction.reply({
      content: 'شما قبلاً عضو شده‌اید. برای خروج از رویداد روی دکمه زیر بزن.',
      components: [row],
      ephemeral: true
    });
  }
  q.addEntry.run(eventId, interaction.user.id, Date.now());
  await refreshMessage(ev);
  if (ev.kind === 'drop' && countOf(eventId) >= ev.winner_count) {
    // Lock it synchronously in the DB before the async message edit to prevent race entries.
    const current = q.getEvent.get(eventId);
    if (current?.status === 'active') {
      const winners = q.entrants.all(eventId).slice(0, current.winner_count).map(x => x.user_id);
      q.endEvent.run(JSON.stringify(winners), eventId);
      await announceEnd(current, winners);
    }
  }
  return interaction.reply({ content: ev.kind === 'drop' ? 'Claim ثبت شد!' : 'با موفقیت وارد گیواوی شدی! 💖', ephemeral: true });
}
async function showHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎉 Giveaway Bot — Help')
    .setDescription('ساخته‌شده توسط **Mehdi** · `itskingpubgyt`')
    .addFields(
      { name: '/giveaway', value: '`prize`, `duration`, `winners` و در صورت نیاز `condition`, `sponsor_url`, `mode`.\nاگر شرط خالی باشد: «💖 بدون شرط، عشق کنید!»' },
      { name: '/drop', value: 'دراپ اولین‌نفر-اولین‌برنده است؛ به تعداد `winners` نفر اول برنده می‌شوند. `mode` روی button یا text قرار بگیرد. در حالت text، `entry_text` را هم وارد کن؛ اولین کسانی که متن دقیق را در همان کانال بفرستند برنده می‌شوند.' },
      { name: '/enter message_id', value: 'ورود به رویدادهای text-mode؛ برای drop هم Claim محسوب می‌شود.' },
      { name: '/leave message_id', value: 'خروج از giveaway در حالت text.' },
      { name: '/reroll message_id [winners]', value: 'انتخاب دوباره برندگان از بین شرکت‌کنندگان همان رویداد. فقط برای رویداد پایان‌یافته.' },
      { name: '/help', value: 'نمایش همین راهنما به‌صورت خصوصی.' },
      { name: 'Modes', value: '**button:** دکمه ورود با شمارنده زنده.\n**text:** کاربران باید دقیقاً متن تعیین‌شده را در همان کانال بنویسند؛ دراپ به تعداد برنده‌ها از اولین پیام‌های صحیح برنده می‌شود. برای این قابلیت باید Message Content Intent در Developer Portal فعال باشد.\n**Sponsor URL:** دکمه Sponsor Server کنار دکمه ورود.' },
      { name: 'زمان‌بندی', value: 'بعد از پایان زمان، ورودها در منطق بات رد می‌شوند. به‌روزرسانی ظاهری دکمه به تأخیر شبکه/دیسکورد وابسته است.' }
    )
    .setFooter({ text: 'Mehdi • itskingpubgyt' });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

client.on('messageCreate', async message => {
  try {
    if (!message.guild || message.author.bot) return;
    const events = q.active.all().filter(ev =>
      ev.guild_id === message.guildId &&
      ev.channel_id === message.channelId &&
      ev.mode === 'text' &&
      ev.entry_text &&
      (ev.kind === 'drop' || (ev.kind === 'giveaway' && Date.now() < ev.ends_at))
    );
    // The exact phrase is matched after trimming outer whitespace; comparison is case-sensitive.
    for (const ev of events) {
      if (message.content.trim() !== ev.entry_text) continue;
      if (ev.kind === 'giveaway' && Date.now() >= ev.ends_at) {
        await finishGiveaway(ev);
        continue;
      }
      if (q.hasEntry.get(ev.message_id, message.author.id)) {
        // Avoid spamming public channels; user already entered.
        continue;
      }
      q.addEntry.run(ev.message_id, message.author.id, Date.now());
      await refreshMessage(ev);
      await message.reply({ content: `✅ <@${message.author.id}> ثبت شد!`, allowedMentions: { users: [message.author.id] } }).catch(() => {});
      if (ev.kind === 'drop' && countOf(ev.message_id) >= ev.winner_count) {
        const current = q.getEvent.get(ev.message_id);
        if (current?.status === 'active') {
          const winners = q.entrants.all(ev.message_id).slice(0, current.winner_count).map(x => x.user_id);
          q.endEvent.run(JSON.stringify(winners), ev.message_id);
          await announceEnd(current, winners);
        }
      }
    }
  } catch (err) {
    console.error('Text-entry error:', err);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === 'help') return showHelp(interaction);
      if (name === 'giveaway' || name === 'drop') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ content: 'برای این دستور به مجوز Manage Server نیاز داری.', ephemeral: true });
        }
        return createEvent(interaction, name);
      }
      if (name === 'enter' || name === 'leave') {
        const id = interaction.options.getString('message_id', true);
        const ev = q.getEvent.get(id);
        if (!ev || ev.mode !== 'text') return interaction.reply({ content: 'رویداد پیدا نشد یا روی حالت text نیست.', ephemeral: true });
        if (ev.guild_id !== interaction.guildId || ev.channel_id !== interaction.channelId) {
          return interaction.reply({ content: 'برای ورود، دستور را در همان سرور و کانال پیام رویداد اجرا کن.', ephemeral: true });
        }
        return handleEntry(interaction, id, name === 'leave' ? 'leave' : 'join');
      }
      if (name === 'reroll') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ content: 'برای این دستور به مجوز Manage Server نیاز داری.', ephemeral: true });
        }
        const id = interaction.options.getString('message_id', true);
        const ev = q.getEvent.get(id);
        if (!ev || ev.status !== 'ended') return interaction.reply({ content: 'رویداد پیدا نشد یا هنوز تمام نشده است.', ephemeral: true });
        const wanted = interaction.options.getInteger('winners') || ev.winner_count;
        const entrants = q.entrants.all(id).map(x => x.user_id);
        const winners = sampleUnique(entrants, wanted);
        q.updateWinners.run(JSON.stringify(winners), id);
        await interaction.reply({
          content: winners.length
            ? `🔁 برندگان جدید: ${winners.map(uid => `<@${uid}>`).join(', ')}`
            : 'شرکت‌کننده‌ای برای انتخاب وجود ندارد.',
          allowedMentions: { users: winners },
          ephemeral: false
        });
        await refreshMessage(ev, true, winners);
        return;
      }
    }
    if (interaction.isButton()) {
      const parts = interaction.customId.split(':');
      if (parts[0] !== 'gw') return;
      const action = parts[1], eventId = parts[2];
      if (action === 'closed') return interaction.reply({ content: 'این رویداد پایان یافته است.', ephemeral: true });
      if (action === 'join') return handleEntry(interaction, eventId, 'join');
      if (action === 'leave') return handleEntry(interaction, eventId, 'leave');
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const message = 'یک خطای داخلی رخ داد. لاگ بات را بررسی کن.';
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Register commands globally so this bot can be used in every server it is invited to.
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
    const modeChoices = [
      { name: 'Button (animated join button)', value: 'button' },
      { name: 'Text command (/enter)', value: 'text' }
    ];
    const commands = [
      new SlashCommandBuilder().setName('giveaway').setDescription('Create a timed giveaway').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(o=>o.setName('prize').setDescription('Prize name').setRequired(true).setMaxLength(200))
        .addStringOption(o=>o.setName('duration').setDescription('e.g. 30m, 2h, 1d (max 30d)').setRequired(true).setMaxLength(20))
        .addIntegerOption(o=>o.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20))
        .addStringOption(o=>o.setName('condition').setDescription('Optional condition').setMaxLength(500))
        .addStringOption(o=>o.setName('sponsor_url').setDescription('Optional sponsor server URL').setMaxLength(500))
        .addStringOption(o=>o.setName('mode').setDescription('Button or text entry').addChoices(...modeChoices)),
      new SlashCommandBuilder().setName('drop').setDescription('Create a first-come claim drop').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(o=>o.setName('prize').setDescription('Prize name').setRequired(true).setMaxLength(200))
        .addIntegerOption(o=>o.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20))
        .addStringOption(o=>o.setName('condition').setDescription('Optional winner instruction').setMaxLength(500))
        .addStringOption(o=>o.setName('entry_text').setDescription('Text users must type to enter (text mode only)').setMaxLength(200))
        .addStringOption(o=>o.setName('sponsor_url').setDescription('Optional sponsor server URL').setMaxLength(500))
        .addStringOption(o=>o.setName('mode').setDescription('Button or text entry').addChoices(...modeChoices)),
      new SlashCommandBuilder().setName('reroll').setDescription('Reroll winners for a finished event').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(o=>o.setName('message_id').setDescription('Event message ID').setRequired(true).setMaxLength(25))
        .addIntegerOption(o=>o.setName('winners').setDescription('Replacement winner count').setMinValue(1).setMaxValue(20)),
      new SlashCommandBuilder().setName('enter').setDescription('Enter a text-mode giveaway or claim a text drop')
        .addStringOption(o=>o.setName('message_id').setDescription('Event message ID').setRequired(true).setMaxLength(25)),
      new SlashCommandBuilder().setName('leave').setDescription('Leave a text-mode giveaway')
        .addStringOption(o=>o.setName('message_id').setDescription('Event message ID').setRequired(true).setMaxLength(25)),
      new SlashCommandBuilder().setName('help').setDescription('Show private bot instructions')
    ].map(c=>c.toJSON());
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Global slash commands registered. They may take time to propagate.');
  } catch (err) { console.error('Command registration failed:', err); }
  await endDueEvents().catch(console.error);
});
client.login(TOKEN);
