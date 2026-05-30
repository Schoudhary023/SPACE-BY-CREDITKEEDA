-- Runtime feature flags for Space web beta access.
-- Use this for gated features such as Gmail sync without redeploying your app.

CREATE TABLE IF NOT EXISTS web_feature_flags_vault (
  id bigserial PRIMARY KEY,
  user_uuid uuid NOT NULL REFERENCES users_vault(user_uuid) ON DELETE CASCADE,
  feature text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_uuid, feature)
);

CREATE INDEX IF NOT EXISTS web_feature_flags_vault_feature_enabled_idx
  ON web_feature_flags_vault (feature, enabled);

-- Enable Gmail sync for a beta user:
-- INSERT INTO web_feature_flags_vault (user_uuid, feature, enabled)
-- VALUES ('USER_UUID_HERE', 'gmail_sync', true)
-- ON CONFLICT (user_uuid, feature)
-- DO UPDATE SET enabled = true, updated_at = now();

-- Enable Gmail sync by Space account email:
-- INSERT INTO web_feature_flags_vault (user_uuid, feature, enabled)
-- SELECT user_uuid, 'gmail_sync', true
-- FROM users_vault
-- WHERE lower(email) = lower('user@example.com')
-- ON CONFLICT (user_uuid, feature)
-- DO UPDATE SET enabled = true, updated_at = now();

-- Disable Gmail sync for a beta user:
-- UPDATE web_feature_flags_vault
-- SET enabled = false, updated_at = now()
-- WHERE user_uuid = 'USER_UUID_HERE'
--   AND feature = 'gmail_sync';
