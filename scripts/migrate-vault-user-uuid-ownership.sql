BEGIN;

-- Adds platform-neutral ownership to vault-owned tables.
--
-- This migration is intentionally additive. Existing Telegram code continues
-- to read/write by telegram_id. The new user_uuid columns let future web/API
-- code address the same vault without making telegram_id the permanent owner.

ALTER TABLE gift_cards_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid;

ALTER TABLE expiry_reminders_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid;

ALTER TABLE card_events_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid;

ALTER TABLE gmail_accounts_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid;

ALTER TABLE gmail_oauth_states_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid;

ALTER TABLE gmail_processed_messages_vault
  ADD COLUMN IF NOT EXISTS user_uuid uuid;

UPDATE gift_cards_vault gc
   SET user_uuid = u.user_uuid
  FROM users_vault u
 WHERE gc.user_uuid IS NULL
   AND gc.telegram_id = u.telegram_id;

UPDATE expiry_reminders_vault er
   SET user_uuid = u.user_uuid
  FROM users_vault u
 WHERE er.user_uuid IS NULL
   AND er.telegram_id = u.telegram_id;

UPDATE card_events_vault ce
   SET user_uuid = u.user_uuid
  FROM users_vault u
 WHERE ce.user_uuid IS NULL
   AND ce.telegram_id = u.telegram_id;

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

CREATE INDEX IF NOT EXISTS gift_cards_vault_user_uuid_redeemed_idx
  ON gift_cards_vault (user_uuid, is_redeemed);

CREATE INDEX IF NOT EXISTS gift_cards_vault_user_uuid_brand_idx
  ON gift_cards_vault (user_uuid, brand);

CREATE INDEX IF NOT EXISTS gift_cards_vault_user_uuid_expiry_date_idx
  ON gift_cards_vault (user_uuid, expiry_date);

CREATE INDEX IF NOT EXISTS expiry_reminders_vault_user_uuid_idx
  ON expiry_reminders_vault (user_uuid);

CREATE INDEX IF NOT EXISTS card_events_vault_user_uuid_idx
  ON card_events_vault (user_uuid);

CREATE UNIQUE INDEX IF NOT EXISTS gmail_accounts_vault_user_uuid_idx
  ON gmail_accounts_vault (user_uuid)
  WHERE user_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS gmail_oauth_states_vault_user_uuid_idx
  ON gmail_oauth_states_vault (user_uuid);

CREATE INDEX IF NOT EXISTS gmail_processed_messages_vault_user_uuid_idx
  ON gmail_processed_messages_vault (user_uuid);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'gift_cards_vault_user_uuid_fkey'
  ) THEN
    ALTER TABLE gift_cards_vault
      ADD CONSTRAINT gift_cards_vault_user_uuid_fkey
      FOREIGN KEY (user_uuid) REFERENCES users_vault(user_uuid) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'expiry_reminders_vault_user_uuid_fkey'
  ) THEN
    ALTER TABLE expiry_reminders_vault
      ADD CONSTRAINT expiry_reminders_vault_user_uuid_fkey
      FOREIGN KEY (user_uuid) REFERENCES users_vault(user_uuid) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'card_events_vault_user_uuid_fkey'
  ) THEN
    ALTER TABLE card_events_vault
      ADD CONSTRAINT card_events_vault_user_uuid_fkey
      FOREIGN KEY (user_uuid) REFERENCES users_vault(user_uuid) ON DELETE CASCADE;
  END IF;

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

COMMIT;
