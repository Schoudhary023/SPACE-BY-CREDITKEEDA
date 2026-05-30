BEGIN;

-- Adds a platform-neutral user identifier for web/app support.
--
-- Existing Telegram flows continue to use telegram_id. This column is additive:
-- current bot queries and inserts keep working because new rows receive a UUID
-- automatically, and existing rows are backfilled by the DEFAULT.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS users_vault_user_uuid_idx
  ON users_vault (user_uuid);

COMMIT;
