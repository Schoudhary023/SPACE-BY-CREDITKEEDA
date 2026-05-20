-- Destructive reset for Space by Creditkeeda tables.
-- Safety guard:
-- 1. Back up data first.
-- 2. Run `select set_config('app.allow_destructive_reset', 'on', false);`
-- 3. Then run this script.
DO $$
BEGIN
  IF current_setting('app.allow_destructive_reset', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Destructive reset blocked. Set app.allow_destructive_reset = on before running this script.';
  END IF;
END $$;

BEGIN;

DROP TABLE IF EXISTS blocked_users_vault CASCADE;
DROP TABLE IF EXISTS analytics_events_vault CASCADE;
DROP TABLE IF EXISTS card_events_vault CASCADE;
DROP TABLE IF EXISTS pending_actions_vault CASCADE;
DROP TABLE IF EXISTS pending_onboarding_vault CASCADE;
DROP TABLE IF EXISTS runtime_abuse_vault CASCADE;
DROP TABLE IF EXISTS rate_limits_vault CASCADE;
DROP TABLE IF EXISTS session_state_vault CASCADE;
DROP TABLE IF EXISTS sessions_vault CASCADE;
DROP TABLE IF EXISTS expiry_reminders_vault CASCADE;
DROP TABLE IF EXISTS gift_cards_vault CASCADE;
DROP TABLE IF EXISTS users_vault CASCADE;

CREATE TABLE users_vault (
  id bigserial PRIMARY KEY,
  telegram_id text UNIQUE NOT NULL,
  username text,
  vault_pin_hash text NOT NULL,
  encryption_salt uuid NOT NULL DEFAULT gen_random_uuid(),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gift_cards_vault (
  id bigserial PRIMARY KEY,
  telegram_id text NOT NULL,
  brand text NOT NULL,
  amount numeric NOT NULL,
  code_encrypted text NOT NULL,
  pin_encrypted text,
  expiry_date date,
  is_redeemed boolean NOT NULL DEFAULT false,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expiry_reminders_vault (
  gift_card_id bigint PRIMARY KEY REFERENCES gift_cards_vault(id) ON DELETE CASCADE,
  telegram_id text NOT NULL,
  reminder_type text NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions_vault (
  id bigserial PRIMARY KEY,
  telegram_id text UNIQUE NOT NULL,
  unlocked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session_state_vault (
  telegram_id text PRIMARY KEY,
  unlocked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pending_onboarding_vault (
  telegram_id text PRIMARY KEY,
  chat_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pending_actions_vault (
  telegram_id text PRIMARY KEY,
  chat_id text NOT NULL,
  action_type text NOT NULL,
  payload_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limits_vault (
  bucket_key text PRIMARY KEY,
  bucket jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runtime_abuse_vault (
  telegram_id text PRIMARY KEY,
  violation_count integer NOT NULL DEFAULT 0,
  window_started_at timestamptz,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE card_events_vault (
  id          bigserial    PRIMARY KEY,
  telegram_id text         NOT NULL,
  card_id     bigint REFERENCES gift_cards_vault(id) ON DELETE CASCADE,
  event_type  text         NOT NULL,
  metadata    jsonb,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE analytics_events_vault (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  user_hash text,
  properties jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blocked_users_vault (
  user_id      bigint      PRIMARY KEY REFERENCES users_vault(id) ON DELETE CASCADE,
  blocked_at   timestamptz NOT NULL DEFAULT now(),
  reason       text,
  unblocked_at timestamptz
);

CREATE INDEX users_vault_telegram_id_idx ON users_vault (telegram_id);
CREATE INDEX gift_cards_vault_telegram_id_idx ON gift_cards_vault (telegram_id);
CREATE INDEX gift_cards_vault_telegram_id_redeemed_idx ON gift_cards_vault (telegram_id, is_redeemed);
CREATE INDEX gift_cards_vault_brand_idx ON gift_cards_vault (brand);
CREATE INDEX gift_cards_vault_expiry_date_idx ON gift_cards_vault (expiry_date);
CREATE INDEX expiry_reminders_vault_telegram_id_idx ON expiry_reminders_vault (telegram_id);
CREATE INDEX sessions_vault_telegram_id_idx ON sessions_vault (telegram_id);
CREATE INDEX session_state_vault_expires_at_idx ON session_state_vault (expires_at);
CREATE INDEX pending_actions_vault_expires_at_idx ON pending_actions_vault (expires_at);
CREATE INDEX runtime_abuse_vault_blocked_until_idx ON runtime_abuse_vault (blocked_until);
CREATE INDEX runtime_abuse_vault_window_started_at_idx ON runtime_abuse_vault (window_started_at);
CREATE INDEX card_events_vault_telegram_id_idx ON card_events_vault (telegram_id);
CREATE INDEX card_events_vault_created_at_idx ON card_events_vault (created_at);
CREATE INDEX analytics_events_vault_event_type_idx ON analytics_events_vault (event_type);
CREATE INDEX analytics_events_vault_created_at_idx ON analytics_events_vault (created_at);
CREATE INDEX analytics_events_vault_user_hash_idx ON analytics_events_vault (user_hash);

ALTER TABLE users_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_cards_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_reminders_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_state_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_onboarding_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_abuse_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_events_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_users_vault ENABLE ROW LEVEL SECURITY;

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

COMMIT;
