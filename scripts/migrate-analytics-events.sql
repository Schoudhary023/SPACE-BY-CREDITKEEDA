DROP TABLE IF EXISTS analytics_events;

CREATE TABLE IF NOT EXISTS analytics_events_vault (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_hash TEXT,
  properties JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE analytics_events_vault ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_aev_type ON analytics_events_vault (event_type);
CREATE INDEX IF NOT EXISTS idx_aev_created ON analytics_events_vault (created_at);
CREATE INDEX IF NOT EXISTS idx_aev_user ON analytics_events_vault (user_hash);
