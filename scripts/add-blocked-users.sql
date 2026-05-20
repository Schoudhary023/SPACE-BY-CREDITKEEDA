-- Permanent user block list
-- Run once in Supabase SQL editor
-- DROP + CREATE handles re-runs and the old telegram_id schema safely (no prod data in this table)

DROP TABLE IF EXISTS blocked_users_vault;

CREATE TABLE blocked_users_vault (
  user_id      BIGINT      PRIMARY KEY REFERENCES users_vault(id) ON DELETE CASCADE,
  blocked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason       TEXT,
  unblocked_at TIMESTAMPTZ
);

ALTER TABLE blocked_users_vault ENABLE ROW LEVEL SECURITY;

-- No user-facing RLS policy — only service role (backend) can read/write
