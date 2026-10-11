# Mehdi Giveaway Bot

Discord giveaway + first-come drop bot using discord.js v14 and SQLite.

**Author:** Mehdi — `itskingpubgyt`

## Features
- `/giveaway`: timed giveaway, 1+ winners, optional sponsor-server URL, optional condition text.
- `/drop`: first-come claim drop, configurable winner count and button/text entry.
- Button mode uses the animated emoji `<a:giveaway:1558889317403860992>` on the join button.
- Live entrant count in both the embed and join button.
- Joining twice gives an ephemeral private response with a **Leave** button.
- Joining/leaving is acknowledged ephemerally.
- At/after the deadline, join actions are rejected in code even if Discord has not yet visually updated the button.
- Winners are selected randomly, announced with mentions, and can be rerolled using `/reroll`.
- `/help` displays private usage instructions.
- SQLite persistence for entries and active giveaways across process restarts (use persistent storage on Railway).

## Commands
- `/giveaway prize duration winners [condition] [entry_text] [sponsor_url] [mode]`
- `/drop prize winners [condition] [entry_text] [sponsor_url] [mode]`
- `/reroll message_id [winners]`
- `/help`

Creation and reroll commands require **Manage Server** permission. The bot needs View Channels, Send Messages, Embed Links, and Read Message History. For text entry, enable the **Message Content Intent** in Discord Developer Portal → Bot. The bot uses Guilds, Guild Messages, and Message Content intents.

### Button vs text mode
- **button**: users join using the animated emoji button.
- **text**: users type the exact `entry_text` phrase in the same channel. The first correct messages win a drop. For giveaways, a correct phrase enters the giveaway. The bot replies privately.

### Important timing limitation
The bot enforces the end timestamp when processing every join/leave interaction, so it will not accept entries after the deadline. However, no Discord bot can guarantee that the visible button is physically disabled at the exact same instant on every client: Discord message edits and network delivery have latency. The scheduler checks frequently and disables the controls as soon as the bot can update the message.

## Setup
1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and fill `DISCORD_TOKEN` and `CLIENT_ID`.
3. In the Discord Developer Portal, enable the bot and invite it with `bot` + `applications.commands` scopes and the permissions above.
4. Run:
   ```bash
   npm install
   npm start
   ```
   The bot registers **global slash commands** automatically at startup, so commands are available in every server where the bot is installed. Discord may take time to propagate global commands.
5. For Railway, set the environment variables and attach a **Volume** mounted at `/app/data`. Set `DATABASE_PATH=/app/data/giveaways.sqlite`. Without a persistent volume, SQLite data can be lost when the service is recreated.

## Duration format
Use values like `30s`, `10m`, `2h`, `1d`, or `1w`. Maximum giveaway duration is 30 days.

## Notes
- A sponsor URL must be a valid `https://` or `http://` URL.
- The `entry_text` phrase is matched exactly (after trimming outer whitespace; case-sensitive). The condition is descriptive text only. The bot does not automatically verify whether someone joined a sponsor server; Discord does not expose reliable membership verification for arbitrary servers unless the bot has the necessary access and configuration. Winners are announced with the configured instruction.
- Do not publish your bot token or commit `.env`.


### Text-mode example
Create `/drop` with `mode=text`, `entry_text=من برنده‌ام`, and `winners=1`. Members must send exactly `من برنده‌ام` in that same channel. The first matching message is the winner; once the configured number of drop winners is reached, the drop closes. Enable Message Content Intent in the Developer Portal or text entry will not work.

## Multi-server / global deployment
This project is configured to register global slash commands and is not tied to one server. Invite the same bot application to each Discord server where you want to use it. Each event stores its guild and channel IDs, while entries are keyed by event message ID, so multiple servers can run independent giveaways through the same bot process and database. Keep one active bot instance using the same persistent SQLite database; do not run multiple independent instances against separate ephemeral disks.
