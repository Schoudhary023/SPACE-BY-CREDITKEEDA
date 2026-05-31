-- Wipes everything tied to a vault user, addressed by user_uuid.
-- Most child tables already cascade on users_vault delete; this function also
-- cleans the few telegram_id-keyed legacy tables and analytics rows that do not.

CREATE OR REPLACE FUNCTION delete_account_by_user_uuid_vault(
  p_user_uuid uuid,
  p_user_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id bigint;
  v_telegram_id text;
BEGIN
  SELECT id, telegram_id
    INTO v_user_id, v_telegram_id
    FROM users_vault
   WHERE user_uuid = p_user_uuid
   FOR UPDATE;

  IF v_telegram_id IS NOT NULL THEN
    DELETE FROM pending_actions_vault       WHERE telegram_id = v_telegram_id;
    DELETE FROM pending_onboarding_vault    WHERE telegram_id = v_telegram_id;
    DELETE FROM session_state_vault         WHERE telegram_id = v_telegram_id;
    DELETE FROM sessions_vault              WHERE telegram_id = v_telegram_id;
    DELETE FROM runtime_abuse_vault         WHERE telegram_id = v_telegram_id;
    DELETE FROM rate_limits_vault
      WHERE bucket_key IN (
        'general:' || v_telegram_id,
        'save:' || v_telegram_id,
        'cards:' || v_telegram_id,
        'image_save:' || v_telegram_id
      );
  END IF;

  -- Also clean web-namespaced rate-limit buckets keyed on user_uuid.
  DELETE FROM rate_limits_vault
    WHERE bucket_key LIKE 'web:%:' || p_user_uuid::text
       OR bucket_key LIKE 'web-ip:%:' || p_user_uuid::text;

  IF p_user_hash IS NOT NULL THEN
    DELETE FROM analytics_events_vault WHERE user_hash = p_user_hash;
  END IF;

  IF v_user_id IS NOT NULL THEN
    DELETE FROM blocked_users_vault WHERE user_id = v_user_id;
  END IF;

  -- This cascades to gift_cards_vault, expiry_reminders_vault, card_events_vault,
  -- gmail_accounts_vault, gmail_oauth_states_vault, gmail_processed_messages_vault,
  -- and telegram_link_tokens_vault.
  DELETE FROM users_vault WHERE user_uuid = p_user_uuid;
END;
$$;
