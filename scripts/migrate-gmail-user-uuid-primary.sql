BEGIN;

-- Make Gmail sync ownership platform-neutral before web launch.
-- Gmail is not live for real users yet, so this migration intentionally moves
-- the schema away from telegram_id primary keys and toward user_uuid ownership.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'gmail_accounts_vault_pkey'
       AND conrelid = 'gmail_accounts_vault'::regclass
  ) THEN
    ALTER TABLE gmail_accounts_vault
      DROP CONSTRAINT gmail_accounts_vault_pkey;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'gmail_processed_messages_vault_pkey'
       AND conrelid = 'gmail_processed_messages_vault'::regclass
  ) THEN
    ALTER TABLE gmail_processed_messages_vault
      DROP CONSTRAINT gmail_processed_messages_vault_pkey;
  END IF;
END $$;

ALTER TABLE gmail_accounts_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid,
  ALTER COLUMN telegram_id DROP NOT NULL;

ALTER TABLE gmail_oauth_states_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'telegram',
  ALTER COLUMN telegram_id DROP NOT NULL,
  ALTER COLUMN chat_id DROP NOT NULL;

ALTER TABLE gmail_processed_messages_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid,
  ALTER COLUMN telegram_id DROP NOT NULL;

UPDATE gmail_accounts_vault ga
   SET user_uuid = u.user_uuid
  FROM users_vault u
 WHERE ga.user_uuid IS NULL
   AND ga.telegram_id = u.telegram_id;

UPDATE gmail_oauth_states_vault gos
   SET user_uuid = u.user_uuid
  FROM users_vault u
 WHERE gos.user_uuid IS NULL
   AND gos.telegram_id = u.telegram_id;

UPDATE gmail_processed_messages_vault gpm
   SET user_uuid = u.user_uuid
  FROM users_vault u
 WHERE gpm.user_uuid IS NULL
   AND gpm.telegram_id = u.telegram_id;

CREATE UNIQUE INDEX IF NOT EXISTS gmail_accounts_vault_telegram_id_idx
  ON gmail_accounts_vault (telegram_id)
  WHERE telegram_id IS NOT NULL;

DROP INDEX IF EXISTS gmail_accounts_vault_user_uuid_idx;

CREATE UNIQUE INDEX IF NOT EXISTS gmail_accounts_vault_user_uuid_idx
  ON gmail_accounts_vault (user_uuid);

CREATE INDEX IF NOT EXISTS gmail_oauth_states_vault_user_uuid_idx
  ON gmail_oauth_states_vault (user_uuid);

CREATE UNIQUE INDEX IF NOT EXISTS gmail_processed_messages_vault_telegram_message_idx
  ON gmail_processed_messages_vault (telegram_id, gmail_message_id)
  WHERE telegram_id IS NOT NULL;

DROP INDEX IF EXISTS gmail_processed_messages_vault_user_uuid_message_idx;

CREATE UNIQUE INDEX IF NOT EXISTS gmail_processed_messages_vault_user_uuid_message_idx
  ON gmail_processed_messages_vault (user_uuid, gmail_message_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'gmail_accounts_vault_user_uuid_fkey'
  ) THEN
    ALTER TABLE gmail_accounts_vault
      ADD CONSTRAINT gmail_accounts_vault_user_uuid_fkey
      FOREIGN KEY (user_uuid) REFERENCES users_vault(user_uuid) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'gmail_oauth_states_vault_user_uuid_fkey'
  ) THEN
    ALTER TABLE gmail_oauth_states_vault
      ADD CONSTRAINT gmail_oauth_states_vault_user_uuid_fkey
      FOREIGN KEY (user_uuid) REFERENCES users_vault(user_uuid) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'gmail_processed_messages_vault_user_uuid_fkey'
  ) THEN
    ALTER TABLE gmail_processed_messages_vault
      ADD CONSTRAINT gmail_processed_messages_vault_user_uuid_fkey
      FOREIGN KEY (user_uuid) REFERENCES users_vault(user_uuid) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE gmail_accounts_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_oauth_states_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_processed_messages_vault ENABLE ROW LEVEL SECURITY;

COMMIT;
