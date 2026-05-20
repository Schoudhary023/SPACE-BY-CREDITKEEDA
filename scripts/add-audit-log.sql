-- Additive migration: audit log for card events
-- Safe to run on existing deployments — no destructive operations.

ALTER TABLE gift_cards_vault
  ADD COLUMN IF NOT EXISTS redeemed_at timestamptz;

CREATE TABLE IF NOT EXISTS card_events_vault (
  id          bigserial    PRIMARY KEY,
  telegram_id text         NOT NULL,
  card_id     bigint,
  event_type  text         NOT NULL,  -- 'saved' | 'redeemed'
  metadata    jsonb,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS card_events_vault_telegram_id_idx ON card_events_vault (telegram_id);
CREATE INDEX IF NOT EXISTS card_events_vault_created_at_idx  ON card_events_vault (created_at);

ALTER TABLE card_events_vault ENABLE ROW LEVEL SECURITY;
