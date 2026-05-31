-- One-time migration: create link token table for Telegram -> Space linking
CREATE TABLE IF NOT EXISTS telegram_link_tokens_vault (
  token       text        PRIMARY KEY,
  user_uuid   uuid        NOT NULL REFERENCES users_vault(user_uuid) ON DELETE CASCADE,
  direction   text        NOT NULL CHECK (direction IN ('telegram_to_web')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_link_tokens_user_uuid_idx
  ON telegram_link_tokens_vault (user_uuid);

ALTER TABLE telegram_link_tokens_vault ENABLE ROW LEVEL SECURITY;
