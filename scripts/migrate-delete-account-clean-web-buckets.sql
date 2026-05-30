-- Extend the bot's delete_account_vault RPC to also wipe web/web-ip rate-limit
-- buckets keyed on user_uuid, so a linked user who deletes via /delete_account
-- leaves no leftover web buckets behind.

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
  v_user_uuid uuid;
BEGIN
  SELECT id, user_uuid
    INTO v_user_id, v_user_uuid
    FROM users_vault
   WHERE telegram_id = p_telegram_id
   FOR UPDATE;

  DELETE FROM pending_actions_vault       WHERE telegram_id = p_telegram_id;
  DELETE FROM pending_onboarding_vault    WHERE telegram_id = p_telegram_id;
  DELETE FROM session_state_vault         WHERE telegram_id = p_telegram_id;
  DELETE FROM sessions_vault              WHERE telegram_id = p_telegram_id;

  DELETE FROM rate_limits_vault
   WHERE bucket_key IN (
     'general:'    || p_telegram_id,
     'save:'       || p_telegram_id,
     'cards:'      || p_telegram_id,
     'image_save:' || p_telegram_id
   );

  IF v_user_uuid IS NOT NULL THEN
    DELETE FROM rate_limits_vault
     WHERE bucket_key LIKE 'web:%:'    || v_user_uuid::text
        OR bucket_key LIKE 'web-ip:%:' || v_user_uuid::text;
  END IF;

  DELETE FROM runtime_abuse_vault    WHERE telegram_id = p_telegram_id;
  DELETE FROM analytics_events_vault WHERE user_hash = p_user_hash;

  PERFORM delete_all_cards_vault(p_telegram_id);

  IF v_user_id IS NOT NULL THEN
    DELETE FROM blocked_users_vault WHERE user_id = v_user_id;
  END IF;

  DELETE FROM users_vault WHERE telegram_id = p_telegram_id;
END;
$$;
