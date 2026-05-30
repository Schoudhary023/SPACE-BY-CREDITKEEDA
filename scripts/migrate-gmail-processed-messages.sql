BEGIN;

CREATE TABLE IF NOT EXISTS gmail_processed_messages_vault (
  telegram_id text NOT NULL,
  gmail_message_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS gmail_processed_messages_vault_processed_at_idx
  ON gmail_processed_messages_vault (processed_at);

ALTER TABLE gmail_processed_messages_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_processed_messages_vault FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE gmail_processed_messages_vault FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'gmail_processed_messages_vault'
       AND policyname = 'gmail_processed_messages_vault_service_role_all'
  ) THEN
    CREATE POLICY gmail_processed_messages_vault_service_role_all
      ON gmail_processed_messages_vault
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

COMMIT;
