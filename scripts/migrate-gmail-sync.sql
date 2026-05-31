BEGIN;

CREATE TABLE IF NOT EXISTS gmail_accounts_vault (
  telegram_id text PRIMARY KEY,
  email_address text NOT NULL,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text,
  scope text,
  token_expires_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gmail_oauth_states_vault (
  state_token text PRIMARY KEY,
  telegram_id text NOT NULL,
  chat_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gmail_accounts_vault_email_address_idx
  ON gmail_accounts_vault (email_address);

CREATE INDEX IF NOT EXISTS gmail_oauth_states_vault_expires_at_idx
  ON gmail_oauth_states_vault (expires_at);

ALTER TABLE gmail_accounts_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_oauth_states_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_accounts_vault FORCE ROW LEVEL SECURITY;
ALTER TABLE gmail_oauth_states_vault FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE gmail_accounts_vault FROM anon, authenticated;
REVOKE ALL ON TABLE gmail_oauth_states_vault FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'gmail_accounts_vault'
       AND policyname = 'gmail_accounts_vault_service_role_all'
  ) THEN
    CREATE POLICY gmail_accounts_vault_service_role_all
      ON gmail_accounts_vault
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'gmail_oauth_states_vault'
       AND policyname = 'gmail_oauth_states_vault_service_role_all'
  ) THEN
    CREATE POLICY gmail_oauth_states_vault_service_role_all
      ON gmail_oauth_states_vault
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

COMMIT;
