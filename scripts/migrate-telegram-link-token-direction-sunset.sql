-- Remove the old Space -> Telegram link direction as part of the Telegram bot sunset.
DELETE FROM telegram_link_tokens_vault
WHERE direction <> 'telegram_to_web';

ALTER TABLE telegram_link_tokens_vault
  DROP CONSTRAINT IF EXISTS telegram_link_tokens_vault_direction_check;

ALTER TABLE telegram_link_tokens_vault
  ADD CONSTRAINT telegram_link_tokens_vault_direction_check
  CHECK (direction IN ('telegram_to_web'));
