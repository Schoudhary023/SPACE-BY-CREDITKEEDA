# Space by Creditkeeda

Space by Creditkeeda is a Telegram bot for storing gift cards in a PIN-protected vault. Card codes and card PINs are encrypted before they are stored in Supabase.

## Features

- Save gift cards from plain text, forwarded text, or screenshots.
- Optional Vertex AI parsing for free-form text and screenshots.
- Encrypt card codes and PINs with a user vault PIN.
- Show, search, redeem, and delete saved cards.
- Send expiry reminders for cards expiring within 7 days.
- Keep sensitive bot actions restricted to private Telegram chats.
- Store onboarding, pending actions, rate limit, and reminder state in Supabase.

## Requirements

- Node.js 20 or newer
- npm
- A Telegram bot token from BotFather
- A Supabase project

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file:

   ```bash
   cp .env.example .env
   ```

3. Fill in `.env`.

   Required values:
   - `TELEGRAM_BOT_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ENCRYPTION_SECRET` or `ENCRYPTION_SECRET_V1`
   - `EXPIRY_REMINDER_CRON`
   - `EXPIRY_REMINDER_TIMEZONE`

   Generate a strong local encryption secret with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. Create the database schema.

   Open the Supabase SQL editor and run:

   ```text
   supabase_schema.sql
   ```

5. Start the bot:

   ```bash
   npm start
   ```

## Optional Environment

AI parsing is disabled by default. To enable it, set:

```env
VERTEX_API_KEY=
AI_PARSING_ENABLED=true
```

When AI parsing is enabled, gift card text and images are sent to Vertex AI before local encryption. Keep this disabled unless users have clear notice and consent.

The optional health server is enabled only when `HEALTH_PORT` is set:

```env
HEALTH_PORT=3100
HEALTH_BIND_ADDRESS=127.0.0.1
HEALTH_TOKEN=
```

The health routes are:

- `GET /health`
- `GET /ready`

If you bind the health server to anything other than `127.0.0.1`, set `HEALTH_TOKEN` and send it with the `x-health-token` header.

## Development

Run tests:

```bash
npm test
```

Check the entry point syntax:

```bash
npm run check
```

Format source files:

```bash
npm run format
```

Check formatting:

```bash
npm run format:check
```

## Security Notes

- Never commit `.env`, `.env.local`, service role keys, bot tokens, or AI API keys.
- `.env.example` contains only empty placeholders and safe defaults.
- The Supabase service role key is used by the backend only.
- Card codes and card PINs are encrypted before storage.
- User vault PINs are hashed with bcrypt and are not stored in plaintext.
- Runtime logs redact common token, key, secret, password, and PIN fields.
