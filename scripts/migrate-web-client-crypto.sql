-- Web client-side encryption metadata.
-- Telegram/server-side cards remain crypto_mode='server'. New Space web cards
-- use crypto_mode='client' and are encrypted/decrypted in the browser.

ALTER TABLE gift_cards_vault
  ADD COLUMN IF NOT EXISTS crypto_mode text NOT NULL DEFAULT 'server',
  ADD COLUMN IF NOT EXISTS crypto_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS code_fingerprint text;

ALTER TABLE gift_cards_vault
  DROP CONSTRAINT IF EXISTS gift_cards_vault_crypto_mode_check;

ALTER TABLE gift_cards_vault
  ADD CONSTRAINT gift_cards_vault_crypto_mode_check
  CHECK (crypto_mode IN ('server', 'client'));

CREATE INDEX IF NOT EXISTS gift_cards_vault_user_uuid_code_fingerprint_idx
  ON gift_cards_vault (user_uuid, code_fingerprint)
  WHERE code_fingerprint IS NOT NULL;
