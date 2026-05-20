ALTER TABLE gift_cards_vault
  ALTER COLUMN pin_encrypted DROP NOT NULL,
  ALTER COLUMN expiry_date DROP NOT NULL;
