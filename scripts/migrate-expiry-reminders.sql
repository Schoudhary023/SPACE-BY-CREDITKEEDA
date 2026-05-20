CREATE TABLE IF NOT EXISTS expiry_reminders_vault (
  gift_card_id bigint NOT NULL,
  telegram_id text NOT NULL,
  reminder_type text NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gift_card_id, reminder_type)
);

ALTER TABLE expiry_reminders_vault
  DROP CONSTRAINT IF EXISTS expiry_reminders_vault_pkey;

ALTER TABLE expiry_reminders_vault
  ADD PRIMARY KEY (gift_card_id, reminder_type);

CREATE INDEX IF NOT EXISTS gift_cards_vault_expiry_date_idx
  ON gift_cards_vault (expiry_date);

CREATE INDEX IF NOT EXISTS expiry_reminders_vault_telegram_id_idx
  ON expiry_reminders_vault (telegram_id);

ALTER TABLE gift_cards_vault
  DROP COLUMN IF EXISTS expiry_7d_notified_at;
