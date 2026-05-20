-- Adds a platform-agnostic encryption salt to each user.
--
-- Previously, encryption used telegram_id as the KDF salt, which tied
-- decryption to the Telegram platform. This column replaces that with a
-- stable UUID that is independent of any platform (Telegram, web, app).
--
-- gen_random_uuid() is called per-row, so every existing user gets a
-- distinct random UUID. New users receive one automatically via the DEFAULT.
--
-- After running this migration, deploy the updated application code.
-- All new gift card encryptions will use encryption_salt as the KDF salt.

ALTER TABLE users_vault
  ADD COLUMN IF NOT EXISTS encryption_salt uuid NOT NULL DEFAULT gen_random_uuid();
