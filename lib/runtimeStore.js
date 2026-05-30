const { decryptForRuntime, encryptForRuntime } = require("./crypto");
const { logWarn } = require("./logger");
const { supabase } = require("./supabase");

const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;
const VIOLATION_WINDOW_MS = (Number(process.env.VIOLATION_WINDOW_MINUTES) || 10) * 60 * 1000;
const VIOLATION_THRESHOLD = Number(process.env.VIOLATION_THRESHOLD) || 5;
const BLOCK_DURATION_MS = (Number(process.env.BLOCK_DURATION_HOURS) || 1) * 60 * 60 * 1000;

function normalizeTelegramId(telegramId) {
  return String(telegramId);
}

function serializePayload(payload = {}) {
  return encryptForRuntime(JSON.stringify(payload));
}

function deserializePayload(payloadEncrypted) {
  if (!payloadEncrypted) {
    return {};
  }

  const encryptedValue = typeof payloadEncrypted === "string" ? payloadEncrypted : JSON.stringify(payloadEncrypted);
  return JSON.parse(decryptForRuntime(encryptedValue));
}

function isMissingColumnError(error) {
  return error && error.code === "42703";
}

function isMissingRelationError(error) {
  return error && error.code === "42P01";
}

function normalizePendingActionRow(data) {
  if (!data) {
    return null;
  }

  const encryptedPayload = data.payload_encrypted ?? data.payload ?? null;

  return {
    ...data,
    payload: deserializePayload(encryptedPayload),
  };
}

async function getPendingOnboarding(telegramId) {
  let response = await supabase
    .from("pending_onboarding_vault")
    .select("telegram_id, chat_id, attempts")
    .eq("telegram_id", normalizeTelegramId(telegramId))
    .maybeSingle();

  if (isMissingRelationError(response.error)) {
    response = await supabase
      .from("bot_pending_onboarding")
      .select("telegram_id, chat_id, attempts")
      .eq("telegram_id", normalizeTelegramId(telegramId))
      .maybeSingle();
  }

  const { data, error } = response;

  if (error) {
    throw error;
  }

  return data;
}

async function clearPendingOnboarding(telegramId) {
  let response = await supabase
    .from("pending_onboarding_vault")
    .delete()
    .eq("telegram_id", normalizeTelegramId(telegramId));

  if (isMissingRelationError(response.error)) {
    response = await supabase
      .from("bot_pending_onboarding")
      .delete()
      .eq("telegram_id", normalizeTelegramId(telegramId));
  }

  if (response.error) {
    throw response.error;
  }
}

async function getPendingAction(telegramId) {
  let response = await supabase
    .from("pending_actions_vault")
    .select("telegram_id, chat_id, action_type, payload_encrypted, expires_at")
    .eq("telegram_id", normalizeTelegramId(telegramId))
    .maybeSingle();

  if (isMissingRelationError(response.error)) {
    response = await supabase
      .from("bot_pending_actions")
      .select("telegram_id, chat_id, action_type, payload_encrypted, expires_at")
      .eq("telegram_id", normalizeTelegramId(telegramId))
      .maybeSingle();
  } else if (isMissingColumnError(response.error)) {
    response = await supabase
      .from("pending_actions_vault")
      .select("telegram_id, chat_id, action_type, payload_encrypted, expires_at")
      .eq("telegram_id", normalizeTelegramId(telegramId))
      .maybeSingle();
  }

  const { data, error } = response;

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await clearPendingAction(telegramId);
    return null;
  }

  return normalizePendingActionRow(data);
}

async function savePendingAction(telegramId, chatId, actionType, payload = {}, ttlMs = PENDING_ACTION_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const row = {
    telegram_id: normalizeTelegramId(telegramId),
    chat_id: String(chatId),
    action_type: actionType,
    payload_encrypted: serializePayload(payload),
    expires_at: expiresAt,
  };

  let response = await supabase.from("pending_actions_vault").upsert(row, { onConflict: "telegram_id" });

  if (isMissingRelationError(response.error) || isMissingColumnError(response.error)) {
    response = await supabase
      .from("bot_pending_actions")
      .upsert(
        {
          telegram_id: normalizeTelegramId(telegramId),
          chat_id: String(chatId),
          action_type: actionType,
          payload_encrypted: row.payload_encrypted,
          expires_at: expiresAt,
        },
        { onConflict: "telegram_id" }
      );
  }

  if (response.error) {
    throw response.error;
  }
}

async function clearPendingAction(telegramId) {
  let response = await supabase
    .from("pending_actions_vault")
    .delete()
    .eq("telegram_id", normalizeTelegramId(telegramId));

  if (isMissingRelationError(response.error)) {
    response = await supabase
      .from("bot_pending_actions")
      .delete()
      .eq("telegram_id", normalizeTelegramId(telegramId));
  }

  if (response.error) {
    throw response.error;
  }
}

async function isBlocked(telegramId) {
  const key = normalizeTelegramId(telegramId);
  const { data, error } = await supabase
    .from("runtime_abuse_vault")
    .select("blocked_until")
    .eq("telegram_id", key)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data?.blocked_until) {
    return false;
  }

  const blockedUntilMs = new Date(data.blocked_until).getTime();
  if (Number.isNaN(blockedUntilMs) || blockedUntilMs <= Date.now()) {
    await supabase
      .from("runtime_abuse_vault")
      .update({ blocked_until: null })
      .eq("telegram_id", key)
      .not("blocked_until", "is", null);
    return false;
  }

  return true;
}

async function recordViolation(telegramId) {
  const { data, error } = await supabase.rpc("record_violation_vault", {
    p_telegram_id: normalizeTelegramId(telegramId),
    p_window_minutes: Math.max(1, Math.ceil(VIOLATION_WINDOW_MS / 60000)),
    p_threshold: VIOLATION_THRESHOLD,
    p_block_hours: Math.max(1, Math.ceil(BLOCK_DURATION_MS / (60 * 60 * 1000))),
  });

  if (error) {
    throw error;
  }

  return Boolean(data?.[0]?.just_blocked);
}

async function checkRateLimit(bucketKey, limit, windowMs) {
  const { data, error } = await supabase.rpc("check_rate_limit_vault", {
    p_bucket_key: String(bucketKey),
    p_limit: Number(limit),
    p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
  });

  if (error) {
    throw error;
  }

  return {
    allowed: Boolean(data?.[0]?.allowed),
    retryAfter: Number(data?.[0]?.retry_after || 0),
  };
}

async function hydrateSessionPin(_telegramId) {
  return null;
}

async function clearSessionPin(telegramId) {
  const key = normalizeTelegramId(telegramId);

  let response = await supabase.from("session_state_vault").delete().eq("telegram_id", key);

  if (isMissingRelationError(response.error)) {
    response = await supabase.from("sessions_vault").delete().eq("telegram_id", key);
  }

  if (response.error) {
    throw response.error;
  }
}

async function clearUserRateLimits(telegramId) {
  const key = normalizeTelegramId(telegramId);
  const bucketKeys = [`general:${key}`, `save:${key}`, `cards:${key}`, `image_save:${key}`];

  const { error } = await supabase
    .from("rate_limits_vault")
    .delete()
    .in("bucket_key", bucketKeys);

  if (error) {
    throw error;
  }

  const { error: abuseError } = await supabase
    .from("runtime_abuse_vault")
    .delete()
    .eq("telegram_id", key);

  if (abuseError) {
    throw abuseError;
  }
}

const permanentBlockCache = new Map();
const PERM_BLOCK_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveUserId(telegramId) {
  const { data, error } = await supabase
    .from("users_vault")
    .select("id")
    .eq("telegram_id", String(telegramId))
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

async function isPermanentlyBlocked(telegramId) {
  const key = String(telegramId);
  const now = Date.now();
  const cached = permanentBlockCache.get(key);

  if (cached && now - cached.cachedAt < PERM_BLOCK_CACHE_TTL_MS) {
    return cached.blocked;
  }

  try {
    const userId = await resolveUserId(key);
    if (!userId) {
      permanentBlockCache.set(key, { blocked: false, cachedAt: now });
      return false;
    }

    const { data, error } = await supabase
      .from("blocked_users_vault")
      .select("user_id, unblocked_at")
      .eq("user_id", userId)
      .is("unblocked_at", null)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const blocked = Boolean(data);
    permanentBlockCache.set(key, { blocked, cachedAt: now });
    return blocked;
  } catch (err) {
    logWarn("isPermanentlyBlocked DB check failed, failing open", { telegramId, error: err.message });
    return false;
  }
}

async function permanentlyBlockUser(telegramId, reason = null) {
  const key = String(telegramId);
  const userId = await resolveUserId(key);

  if (!userId) {
    throw new Error(`User ${key} is not registered and cannot be blocked.`);
  }

  const { error } = await supabase
    .from("blocked_users_vault")
    .upsert(
      { user_id: userId, reason, unblocked_at: null },
      { onConflict: "user_id" }
    );

  if (error) {
    throw error;
  }

  permanentBlockCache.set(key, { blocked: true, cachedAt: Date.now() });
}

async function permanentlyUnblockUser(telegramId) {
  const key = String(telegramId);
  const userId = await resolveUserId(key);

  if (!userId) {
    throw new Error(`User ${key} is not registered.`);
  }

  const { error } = await supabase
    .from("blocked_users_vault")
    .update({ unblocked_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

  permanentBlockCache.set(key, { blocked: false, cachedAt: Date.now() });
}

async function pruneRuntimeState() {
  const nowIso = new Date().toISOString();
  const staleWindowIso = new Date(Date.now() - (VIOLATION_WINDOW_MS * 2)).toISOString();

  for (const [key, entry] of permanentBlockCache) {
    if (Date.now() - entry.cachedAt >= PERM_BLOCK_CACHE_TTL_MS) {
      permanentBlockCache.delete(key);
    }
  }

  const { error: pendingError } = await supabase
    .from("pending_actions_vault")
    .delete()
    .lte("expires_at", nowIso);

  if (pendingError) {
    throw pendingError;
  }

  const { error: gmailOauthError } = await supabase
    .from("gmail_oauth_states_vault")
    .delete()
    .lte("expires_at", nowIso);

  if (gmailOauthError && !isMissingRelationError(gmailOauthError)) {
    throw gmailOauthError;
  }

  let response = await supabase.from("session_state_vault").delete().lte("expires_at", nowIso);

  if (isMissingRelationError(response.error)) {
    response = await supabase.from("bot_session_state").delete().lte("expires_at", nowIso);
  }

  if (response.error && !isMissingRelationError(response.error)) {
    throw response.error;
  }

  const { error: blockedAbuseError } = await supabase
    .from("runtime_abuse_vault")
    .delete()
    .lte("blocked_until", nowIso);

  if (blockedAbuseError) {
    throw blockedAbuseError;
  }

  const { error: staleAbuseError } = await supabase
    .from("runtime_abuse_vault")
    .delete()
    .is("blocked_until", null)
    .lte("window_started_at", staleWindowIso);

  if (staleAbuseError) {
    throw staleAbuseError;
  }
}

module.exports = {
  checkRateLimit,
  isBlocked,
  isPermanentlyBlocked,
  permanentlyBlockUser,
  permanentlyUnblockUser,
  recordViolation,
  clearPendingAction,
  clearPendingOnboarding,
  clearSessionPin,
  clearUserRateLimits,
  getPendingAction,
  getPendingOnboarding,
  hydrateSessionPin,
  pruneRuntimeState,
  savePendingAction,
};
