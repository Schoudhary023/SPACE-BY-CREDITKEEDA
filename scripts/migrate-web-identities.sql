BEGIN;

-- Adds optional web identity fields for Space web login.
--
-- Telegram users can continue without auth_user_id/email. Web-first users can
-- be attached to the same platform-neutral user_uuid later.

ALTER TABLE users_vault
  ADD COLUMN IF NOT EXISTS auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS web_linked_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS users_vault_auth_user_id_idx
  ON users_vault (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_vault_email_lower_idx
  ON users_vault (lower(email))
  WHERE email IS NOT NULL;

COMMIT;
