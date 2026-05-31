BEGIN;

-- Makes Telegram an optional linked identity instead of the required owner.
--
-- This is required for web-first Space users. Existing Telegram users keep
-- their telegram_id values, and the existing unique index still prevents two
-- users from linking the same Telegram account.

ALTER TABLE users_vault
  ALTER COLUMN telegram_id DROP NOT NULL;

ALTER TABLE gift_cards_vault
  ALTER COLUMN telegram_id DROP NOT NULL;

ALTER TABLE card_events_vault
  ALTER COLUMN telegram_id DROP NOT NULL;

COMMIT;
