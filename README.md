# CreditKeeda Space — Open-Source Backend

This is the open-source backend for **CreditKeeda Space**, a secure gift card vault. It includes a Telegram bot and a REST API for a web frontend.

We open-source this code so users can verify there is no backdoor to their data. You can read `lib/crypto.js` and `lib/vaultSessions.js` to confirm:

- The vault PIN is never stored in plaintext.
- Gift card codes and PINs are encrypted with a key derived from the user's PIN before touching the database.
- The server cannot read your card codes without knowing your PIN.

The web frontend (Space web app) is a separate project and is not included in this repository.

## Security Model

**Zero-knowledge encryption for card data:**

- `lib/crypto.js` — AES-256-GCM encryption. The encryption key is derived using scrypt from: `ENCRYPTION_SECRET + vaultPin + encryptionSalt`. Without the PIN, the server cannot decrypt the data.
- `lib/vaultSessions.js` — PIN verification. Only a bcrypt hash of the PIN is stored in the database. The raw PIN lives only in memory during an active session and is cleared on server restart.
- `encryptionSalt` — a random UUID stored per-user in the database. It is platform-agnostic so the same data can be decrypted by the Telegram bot and the web app using the same PIN.

**What is stored in the database:**
- Encrypted gift card codes and PINs (`code_encrypted`, `pin_encrypted`) — cannot be read without the user's PIN.
- A bcrypt hash of the vault PIN (`vault_pin_hash`) — irreversible.
- An encryption salt UUID (`encryption_salt`) — not a secret; used as KDF input.

**What is never stored:**
- The raw vault PIN.
- The derived encryption key.

## What This Repository Contains

| Path | Description |
|---|---|
| `index.js` | Telegram bot entry point |
| `api/index.js` | REST API entry point |
| `api/auth.js` | Supabase JWT verification middleware |
| `api/webVaultSessions.js` | In-memory web vault session store |
| `handlers/` | Telegram message and callback handlers |
| `lib/crypto.js` | AES-256-GCM encrypt/decrypt, key rotation |
| `lib/vaultSessions.js` | PIN verification and lockout logic |
| `lib/vaultCards.js` | Card CRUD against the database |
| `lib/gmailSync.js` | Gmail OAuth and gift card import |
| `lib/` | All other shared utilities |
| `scripts/` | SQL migration scripts |
| `tests/` | Unit tests |

The frontend (Space web app) is a separate private repository. This backend is fully functional without it — the Telegram bot works standalone.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from BotFather
- A PostgreSQL database (the schema works with any Postgres provider)

## Self-Hosting Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Create a local environment file:**

   ```bash
   cp .env.example .env
   ```

3. **Fill in `.env`.** Required values:
   - `TELEGRAM_BOT_TOKEN`
   - `SUPABASE_URL` — your Postgres database URL
   - `SUPABASE_SERVICE_ROLE_KEY` — service role key for your database
   - `ENCRYPTION_SECRET` — a long random secret (minimum 32 chars). Generate one:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - `ENCRYPTION_SECRET_WEB` — separate secret for the web API client encryption (also min 32 chars)
   - `EXPIRY_REMINDER_CRON` — cron schedule, e.g. `0 9 * * *`
   - `EXPIRY_REMINDER_TIMEZONE` — e.g. `Asia/Kolkata`

4. **Set up the database schema.** Run `supabase_schema.sql` in your Postgres database (via psql or your provider's SQL editor). This creates all required tables.

5. **Start the Telegram bot:**

   ```bash
   npm start
   # or specifically:
   npm run start:bot
   ```

6. **Start the web API** (needed for the Space web app):

   ```bash
   npm run start:api
   ```

## Optional Features

**AI card parsing** (disabled by default — requires a Vertex AI API key):

```env
VERTEX_API_KEY=your-key-here
AI_PARSING_ENABLED=true
```

When enabled, gift card text and images are sent to Vertex AI for parsing *before* local encryption. Only enable this with appropriate user notice.

**Gmail sync** (optional — requires a Google OAuth app):

```env
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_OAUTH_REDIRECT_URI=https://your-api-domain.com/api/gmail/callback
```

**Health check server** (optional):

```env
HEALTH_PORT=3100
HEALTH_BIND_ADDRESS=127.0.0.1
HEALTH_TOKEN=
```

Endpoints: `GET /health` and `GET /ready`. If you expose the health server publicly, set `HEALTH_TOKEN` and send it as `x-health-token`.

**Web push notifications** (optional):

```bash
npx web-push generate-vapid-keys
```

```env
WEB_PUSH_PUBLIC_KEY=
WEB_PUSH_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:your@email.com
```

## Key Rotation

If you need to rotate the `ENCRYPTION_SECRET`, rename the old one to `ENCRYPTION_SECRET_V1` and set the new one as `ENCRYPTION_SECRET_V2`. All existing ciphertext carries a version prefix — old data continues to decrypt with V1 while new writes use V2. See `lib/crypto.js` for details.

## Running Tests

```bash
npm test
```

## Security Notes

- Never commit `.env`, service role keys, bot tokens, or API keys.
- The database service role key bypasses row-level security — keep it server-only.
- Card codes and card PINs are encrypted before storage; the server cannot read them without the user's PIN.
- User vault PINs are hashed with bcrypt (cost 12) and are not stored in plaintext.
- Failed PIN attempts trigger escalating lockouts (see `lib/vaultSessions.js`).
- Admin commands (`/block`, `/unblock`, `/broadcast`) are silently ignored for all users except the one whose Telegram ID is set in `ADMIN_TELEGRAM_ID`.

## License

MIT
