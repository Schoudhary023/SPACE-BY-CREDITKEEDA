-- Web expiry alerts: push subscriptions and web-first reminder rows.

ALTER TABLE expiry_reminders_vault
  ALTER COLUMN telegram_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS web_push_subscriptions_vault (
  id          bigserial PRIMARY KEY,
  user_uuid   uuid        NOT NULL REFERENCES users_vault(user_uuid) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  user_agent  text,
  last_used_at timestamptz,
  disabled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS web_push_subscriptions_vault_user_uuid_idx
  ON web_push_subscriptions_vault (user_uuid)
  WHERE disabled_at IS NULL;

ALTER TABLE web_push_subscriptions_vault ENABLE ROW LEVEL SECURITY;
