-- Production hardening migration
-- Adds durable abuse controls, secure deletion RPCs, stricter RLS scaffolding,
-- and supporting tables/indexes for production launch.

CREATE TABLE IF NOT EXISTS runtime_abuse_vault (
  telegram_id text PRIMARY KEY,
  violation_count integer NOT NULL DEFAULT 0,
  window_started_at timestamptz,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_abuse_vault_blocked_until_idx ON runtime_abuse_vault (blocked_until);
CREATE INDEX IF NOT EXISTS runtime_abuse_vault_window_started_at_idx ON runtime_abuse_vault (window_started_at);

CREATE TABLE IF NOT EXISTS analytics_events_vault (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_hash TEXT,
  properties JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analytics_events_vault_event_type_idx ON analytics_events_vault (event_type);
CREATE INDEX IF NOT EXISTS analytics_events_vault_created_at_idx ON analytics_events_vault (created_at);
CREATE INDEX IF NOT EXISTS analytics_events_vault_user_hash_idx ON analytics_events_vault (user_hash);

DO $$
BEGIN
  DELETE FROM expiry_reminders_vault er
   WHERE NOT EXISTS (
     SELECT 1
       FROM gift_cards_vault gc
      WHERE gc.id = er.gift_card_id
   );

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'expiry_reminders_vault_gift_card_id_fkey'
  ) THEN
    ALTER TABLE expiry_reminders_vault
      ADD CONSTRAINT expiry_reminders_vault_gift_card_id_fkey
      FOREIGN KEY (gift_card_id) REFERENCES gift_cards_vault(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  DELETE FROM card_events_vault ce
   WHERE ce.card_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM gift_cards_vault gc
        WHERE gc.id = ce.card_id
     );

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'card_events_vault_card_id_fkey'
  ) THEN
    ALTER TABLE card_events_vault
      ADD CONSTRAINT card_events_vault_card_id_fkey
      FOREIGN KEY (card_id) REFERENCES gift_cards_vault(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE runtime_abuse_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events_vault ENABLE ROW LEVEL SECURITY;

UPDATE rate_limits_vault
   SET bucket = (
     SELECT COALESCE(jsonb_agg(normalized.expires_at ORDER BY normalized.expires_at), '[]'::jsonb)
       FROM (
         SELECT CASE
           WHEN value ~ '^\d{13}$' THEN to_timestamp((value)::numeric / 1000.0)
           WHEN value ~ '^\d{10}$' THEN to_timestamp((value)::numeric)
           ELSE value::timestamptz
         END AS expires_at
           FROM jsonb_array_elements_text(COALESCE(bucket, '[]'::jsonb)) AS value
          WHERE (
            value ~ '^\d{13}$'
            OR value ~ '^\d{10}$'
            OR value ~ '^\d{4}-\d{2}-\d{2}'
          )
       ) normalized
      WHERE normalized.expires_at > now()
   ),
       updated_at = now();

CREATE OR REPLACE FUNCTION check_rate_limit_vault(
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE (allowed boolean, retry_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_bucket jsonb := '[]'::jsonb;
  v_pruned jsonb := '[]'::jsonb;
  v_retry_after integer := 0;
  v_value text;
  v_expires_at timestamptz;
BEGIN
  IF p_limit IS NULL OR p_limit <= 0 OR p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'Invalid rate limit parameters';
  END IF;

  INSERT INTO rate_limits_vault (bucket_key, bucket, updated_at)
  VALUES (p_bucket_key, '[]'::jsonb, now())
  ON CONFLICT (bucket_key) DO NOTHING;

  SELECT bucket
    INTO v_bucket
    FROM rate_limits_vault
   WHERE bucket_key = p_bucket_key
   FOR UPDATE;

  FOR v_value IN
    SELECT value
      FROM jsonb_array_elements_text(COALESCE(v_bucket, '[]'::jsonb)) AS value
  LOOP
    BEGIN
      IF v_value ~ '^\d{13}$' THEN
        v_expires_at := to_timestamp((v_value)::numeric / 1000.0);
      ELSIF v_value ~ '^\d{10}$' THEN
        v_expires_at := to_timestamp((v_value)::numeric);
      ELSE
        v_expires_at := v_value::timestamptz;
      END IF;
    EXCEPTION
      WHEN others THEN
        v_expires_at := null;
    END;

    IF v_expires_at IS NOT NULL AND v_expires_at > v_now THEN
      v_pruned := v_pruned || jsonb_build_array(v_expires_at);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_pruned) >= p_limit THEN
    SELECT GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (MIN(value::timestamptz) - v_now)))::integer
    )
      INTO v_retry_after
      FROM jsonb_array_elements_text(v_pruned) AS value;

    UPDATE rate_limits_vault
       SET bucket = v_pruned,
           updated_at = now()
     WHERE bucket_key = p_bucket_key;

    RETURN QUERY SELECT false, COALESCE(v_retry_after, 1);
    RETURN;
  END IF;

  v_pruned := v_pruned || jsonb_build_array((v_now + make_interval(secs => p_window_seconds))::timestamptz);

  UPDATE rate_limits_vault
     SET bucket = v_pruned,
         updated_at = now()
   WHERE bucket_key = p_bucket_key;

  RETURN QUERY SELECT true, 0;
END;
$$;

CREATE OR REPLACE FUNCTION record_violation_vault(
  p_telegram_id text,
  p_window_minutes integer,
  p_threshold integer,
  p_block_hours integer
)
RETURNS TABLE (just_blocked boolean, blocked_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_state runtime_abuse_vault%ROWTYPE;
  v_window_start timestamptz;
  v_violation_count integer;
  v_blocked_until timestamptz;
BEGIN
  IF p_window_minutes IS NULL OR p_window_minutes <= 0 OR p_threshold IS NULL OR p_threshold <= 0 OR p_block_hours IS NULL OR p_block_hours <= 0 THEN
    RAISE EXCEPTION 'Invalid abuse control parameters';
  END IF;

  INSERT INTO runtime_abuse_vault (telegram_id, violation_count, window_started_at, blocked_until, updated_at)
  VALUES (p_telegram_id, 0, v_now, null, now())
  ON CONFLICT (telegram_id) DO NOTHING;

  SELECT *
    INTO v_state
    FROM runtime_abuse_vault
   WHERE telegram_id = p_telegram_id
   FOR UPDATE;

  IF v_state.blocked_until IS NOT NULL AND v_state.blocked_until > v_now THEN
    RETURN QUERY SELECT false, v_state.blocked_until;
    RETURN;
  END IF;

  IF v_state.window_started_at IS NULL OR v_state.window_started_at <= (v_now - make_interval(mins => p_window_minutes)) THEN
    v_window_start := v_now;
    v_violation_count := 1;
  ELSE
    v_window_start := v_state.window_started_at;
    v_violation_count := COALESCE(v_state.violation_count, 0) + 1;
  END IF;

  IF v_violation_count >= p_threshold THEN
    v_blocked_until := v_now + make_interval(hours => p_block_hours);

    UPDATE runtime_abuse_vault
       SET violation_count = 0,
           window_started_at = null,
           blocked_until = v_blocked_until,
           updated_at = now()
     WHERE telegram_id = p_telegram_id;

    RETURN QUERY SELECT true, v_blocked_until;
    RETURN;
  END IF;

  UPDATE runtime_abuse_vault
     SET violation_count = v_violation_count,
         window_started_at = v_window_start,
         blocked_until = null,
         updated_at = now()
   WHERE telegram_id = p_telegram_id;

  RETURN QUERY SELECT false, null::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION delete_all_cards_vault(
  p_telegram_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM expiry_reminders_vault
   WHERE telegram_id = p_telegram_id;

  DELETE FROM card_events_vault
   WHERE telegram_id = p_telegram_id;

  DELETE FROM gift_cards_vault
   WHERE telegram_id = p_telegram_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_account_vault(
  p_telegram_id text,
  p_user_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id bigint;
BEGIN
  SELECT id INTO v_user_id
    FROM users_vault
   WHERE telegram_id = p_telegram_id
   FOR UPDATE;

  DELETE FROM pending_actions_vault
   WHERE telegram_id = p_telegram_id;

  DELETE FROM pending_onboarding_vault
   WHERE telegram_id = p_telegram_id;

  DELETE FROM session_state_vault
   WHERE telegram_id = p_telegram_id;

  DELETE FROM sessions_vault
   WHERE telegram_id = p_telegram_id;

  DELETE FROM rate_limits_vault
   WHERE bucket_key IN (
     'general:' || p_telegram_id,
     'save:' || p_telegram_id,
     'cards:' || p_telegram_id,
     'image_save:' || p_telegram_id
   );

  DELETE FROM runtime_abuse_vault
   WHERE telegram_id = p_telegram_id;

  DELETE FROM analytics_events_vault
   WHERE user_hash = p_user_hash;

  PERFORM delete_all_cards_vault(p_telegram_id);

  IF v_user_id IS NOT NULL THEN
    DELETE FROM blocked_users_vault
     WHERE user_id = v_user_id;
  END IF;

  DELETE FROM users_vault
   WHERE telegram_id = p_telegram_id;
END;
$$;

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'users_vault',
    'gift_cards_vault',
    'expiry_reminders_vault',
    'sessions_vault',
    'session_state_vault',
    'pending_onboarding_vault',
    'pending_actions_vault',
    'rate_limits_vault',
    'runtime_abuse_vault',
    'card_events_vault',
    'analytics_events_vault',
    'blocked_users_vault'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', tbl);

    IF NOT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = tbl
         AND policyname = tbl || '_service_role_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        tbl || '_service_role_all',
        tbl
      );
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION check_rate_limit_vault(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION check_rate_limit_vault(text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION record_violation_vault(text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_violation_vault(text, integer, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION delete_all_cards_vault(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_all_cards_vault(text) TO service_role;

REVOKE ALL ON FUNCTION delete_account_vault(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_account_vault(text, text) TO service_role;
