const { supabase, withSupabaseRetry } = require("./supabase");

const USER_CACHE_TTL_MS = Number(process.env.USER_CACHE_TTL_MS) || 5 * 60 * 1000;
const userByTelegramIdCache = new Map();
const userByAuthUserIdCache = new Map();

function normalizeTelegramId(telegramId) {
  return String(telegramId);
}

function getCachedUser(telegramId) {
  const key = normalizeTelegramId(telegramId);
  const cached = userByTelegramIdCache.get(key);

  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt <= Date.now()) {
    userByTelegramIdCache.delete(key);
    return undefined;
  }

  return cached.user;
}

function cacheUser(telegramId, user) {
  userByTelegramIdCache.set(normalizeTelegramId(telegramId), {
    user,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
}

function forgetUserByTelegramId(telegramId) {
  userByTelegramIdCache.delete(normalizeTelegramId(telegramId));
}

function getCachedAuthUser(authUserId) {
  const key = String(authUserId);
  const cached = userByAuthUserIdCache.get(key);

  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt <= Date.now()) {
    userByAuthUserIdCache.delete(key);
    return undefined;
  }

  return cached.user;
}

function cacheAuthUser(authUserId, user) {
  userByAuthUserIdCache.set(String(authUserId), {
    user,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
}

function forgetUserByAuthUserId(authUserId) {
  userByAuthUserIdCache.delete(String(authUserId));
}

function isMissingRelationError(error) {
  return error && error.code === "42P01";
}

function throwUnlessMissingRelation(error) {
  if (error && !isMissingRelationError(error)) {
    throw error;
  }
}

const VAULT_OWNER_TABLES = [
  "gift_cards_vault",
  "expiry_reminders_vault",
  "card_events_vault",
  "gmail_accounts_vault",
  "gmail_oauth_states_vault",
  "gmail_processed_messages_vault",
];

const TELEGRAM_OWNED_DATA_TABLES = [
  "gift_cards_vault",
  "expiry_reminders_vault",
  "card_events_vault",
];

const VAULT_DATA_TABLES = [
  "gift_cards_vault",
  "expiry_reminders_vault",
  "card_events_vault",
  "gmail_accounts_vault",
  "gmail_processed_messages_vault",
];

const TELEGRAM_RUNTIME_TABLES = [
  "pending_onboarding_vault",
  "pending_actions_vault",
  "sessions_vault",
  "session_state_vault",
];

async function countRowsByUserUuid(table, userUuid) {
  const { count, error } = await withSupabaseRetry(() =>
    supabase
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("user_uuid", String(userUuid))
  );

  throwUnlessMissingRelation(error);
  return error ? 0 : count || 0;
}

async function countRowsByVaultOwner(table, { userUuid, telegramId = null }) {
  let query = supabase
    .from(table)
    .select("*", { count: "exact", head: true });

  if (telegramId) {
    query = query.or(`user_uuid.eq.${String(userUuid)},telegram_id.eq.${String(telegramId)}`);
  } else {
    query = query.eq("user_uuid", String(userUuid));
  }

  const { count, error } = await withSupabaseRetry(() => query);

  throwUnlessMissingRelation(error);
  return error ? 0 : count || 0;
}

async function getVaultDataSummary(userUuid, { telegramId = null } = {}) {
  const counts = {};
  for (const table of VAULT_DATA_TABLES) {
    counts[table] = await countRowsByVaultOwner(table, { userUuid, telegramId });
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    counts,
    total,
    hasData: total > 0,
    cardCount: counts.gift_cards_vault || 0,
  };
}

async function backfillTelegramOwnedDataToUserUuid(userUuid, telegramId) {
  if (!userUuid || !telegramId) return;

  for (const table of TELEGRAM_OWNED_DATA_TABLES) {
    const { error } = await withSupabaseRetry(() =>
      supabase
        .from(table)
        .update({ user_uuid: String(userUuid) })
        .eq("telegram_id", String(telegramId))
    );
    throwUnlessMissingRelation(error);
  }
}

async function backfillLinkedTelegramData(userUuid) {
  const user = await getUserByUserUuid(userUuid);
  await backfillTelegramOwnedDataToUserUuid(user?.user_uuid, user?.telegram_id);
}

async function getVaultCardCount(userUuid) {
  return countRowsByUserUuid("gift_cards_vault", userUuid);
}

// The bot reads cards by telegram_id (see fetchCards), so the "is this an active
// vault" gate must count by telegram_id too. Counting by user_uuid would report 0
// for any existing card row whose user_uuid was never backfilled, wrongly bouncing
// a real user to the "moved to web" message.
async function getVaultCardCountByTelegramId(telegramId) {
  const { count, error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .select("*", { count: "exact", head: true })
      .eq("telegram_id", String(telegramId))
  );

  throwUnlessMissingRelation(error);
  return error ? 0 : count || 0;
}

async function setTelegramIdForVault(userUuid, { telegramId, username = null }) {
  const normalizedTelegramId = telegramId == null ? null : String(telegramId);
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .update({ telegram_id: normalizedTelegramId, username: normalizedTelegramId ? username || null : null })
      .eq("user_uuid", String(userUuid))
  );

  if (error) throw error;

  for (const table of VAULT_OWNER_TABLES) {
    const { error: ownerError } = await withSupabaseRetry(() =>
      supabase
        .from(table)
        .update({ telegram_id: normalizedTelegramId })
        .eq("user_uuid", String(userUuid))
    );
    throwUnlessMissingRelation(ownerError);
  }

  if (normalizedTelegramId) {
    forgetUserByTelegramId(normalizedTelegramId);
  }
}

async function setWebIdentityForVault(userUuid, { authUserId, email }) {
  const existing = await getUserByUserUuid(userUuid);
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .update({
        auth_user_id: String(authUserId),
        email: email || null,
        web_linked_at: new Date().toISOString(),
      })
      .eq("user_uuid", String(userUuid))
  );

  if (error) throw error;
  await backfillTelegramOwnedDataToUserUuid(userUuid, existing?.telegram_id);
  forgetUserByAuthUserId(authUserId);
}

async function deleteTelegramRuntimeState(telegramId) {
  if (!telegramId) return;

  for (const table of TELEGRAM_RUNTIME_TABLES) {
    const { error } = await withSupabaseRetry(() =>
      supabase
        .from(table)
        .delete()
        .eq("telegram_id", String(telegramId))
    );
    throwUnlessMissingRelation(error);
  }
}

async function deleteVaultShell(user) {
  if (!user?.user_uuid) return;

  const summary = await getVaultDataSummary(user.user_uuid, { telegramId: user.telegram_id });
  if (summary.hasData) {
    const error = new Error("Cannot delete a vault that contains data");
    error.code = "VAULT_HAS_DATA";
    throw error;
  }

  for (const table of VAULT_OWNER_TABLES) {
    const { error } = await withSupabaseRetry(() =>
      supabase
        .from(table)
        .delete()
        .eq("user_uuid", String(user.user_uuid))
    );
    throwUnlessMissingRelation(error);
  }

  const { error: tokenError } = await withSupabaseRetry(() =>
    supabase
      .from("telegram_link_tokens_vault")
      .delete()
      .eq("user_uuid", String(user.user_uuid))
  );
  throwUnlessMissingRelation(tokenError);

  await deleteTelegramRuntimeState(user.telegram_id);

  const { error: userError } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .delete()
      .eq("user_uuid", String(user.user_uuid))
  );
  if (userError) throw userError;

  if (user.telegram_id) {
    forgetUserByTelegramId(user.telegram_id);
  }
  if (user.auth_user_id) {
    forgetUserByAuthUserId(user.auth_user_id);
  }
}

async function clearLinkTokensForVault(userUuid) {
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("telegram_link_tokens_vault")
      .delete()
      .eq("user_uuid", String(userUuid))
  );
  throwUnlessMissingRelation(error);
}

async function getUserByTelegramId(telegramId) {
  const key = normalizeTelegramId(telegramId);
  const cached = getCachedUser(key);

  if (cached !== undefined) {
    return cached;
  }

  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select("telegram_id, user_uuid, encryption_salt, auth_user_id, email, web_linked_at")
      .eq("telegram_id", key)
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  cacheUser(key, data || null);
  return data || null;
}

async function createTelegramUser({ telegramId, username = null, vaultPinHash }) {
  const key = normalizeTelegramId(telegramId);
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .insert({
        telegram_id: key,
        username,
        vault_pin_hash: vaultPinHash,
      })
      .select("telegram_id, user_uuid, encryption_salt")
      .single()
  );

  if (error) {
    throw error;
  }

  cacheUser(key, data);
  return data;
}

async function getUserByAuthUserId(authUserId) {
  const key = String(authUserId || "").trim();

  if (!key) {
    return null;
  }

  const cached = getCachedAuthUser(key);

  if (cached !== undefined) {
    return cached;
  }

  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select("user_uuid, telegram_id, auth_user_id, email, web_linked_at")
      .eq("auth_user_id", key)
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  cacheAuthUser(key, data || null);
  return data || null;
}

async function getUserByEmail(email) {
  const key = String(email || "").trim().toLowerCase();

  if (!key) {
    return null;
  }

  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select("user_uuid, telegram_id, auth_user_id, email, web_linked_at")
      .ilike("email", key)
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  return data || null;
}

async function attachAuthUserToVault(userUuid, { authUserId, email }) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .update({
        auth_user_id: String(authUserId),
        email: email || null,
        web_linked_at: new Date().toISOString(),
      })
      .eq("user_uuid", String(userUuid))
      .select("user_uuid, telegram_id, auth_user_id, email, web_linked_at")
      .single()
  );

  if (error) {
    throw error;
  }

  forgetUserByAuthUserId(authUserId);
  cacheAuthUser(authUserId, data);
  return data;
}

async function getUserByAuthUserOrEmail(authUser) {
  const authUserId = authUser?.id;
  const email = authUser?.email || null;
  const byAuthId = await getUserByAuthUserId(authUserId);

  if (byAuthId || !email) {
    return byAuthId;
  }

  const byEmail = await getUserByEmail(email);
  if (!byEmail) {
    return null;
  }

  if (!byEmail.auth_user_id || byEmail.auth_user_id !== String(authUserId)) {
    return attachAuthUserToVault(byEmail.user_uuid, { authUserId, email });
  }

  cacheAuthUser(authUserId, byEmail);
  return byEmail;
}

async function getUserByUserUuid(userUuid) {
  const key = String(userUuid || "").trim();

  if (!key) {
    return null;
  }

  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select("user_uuid, telegram_id, auth_user_id, email, web_linked_at, encryption_salt")
      .eq("user_uuid", key)
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  return data || null;
}

async function createWebUser({ authUserId, email, vaultPinHash }) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .insert({
        auth_user_id: authUserId,
        email: email || null,
        web_linked_at: new Date().toISOString(),
        vault_pin_hash: vaultPinHash,
      })
      .select("user_uuid, telegram_id, auth_user_id, email, web_linked_at, encryption_salt")
      .single()
  );

  if (error) {
    throw error;
  }

  cacheAuthUser(authUserId, data);
  return data;
}

async function getTelegramUserForLink(telegramId) {
  // Bypasses cache — needs fresh state for security-sensitive link operations
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select("telegram_id, username, user_uuid, auth_user_id, email, web_linked_at")
      .eq("telegram_id", String(telegramId))
      .maybeSingle()
  );

  if (error) throw error;
  return data || null;
}

async function linkTelegramToWebVault(userUuid, { authUserId, email }) {
  await setWebIdentityForVault(userUuid, { authUserId, email });
}

function buildMergeRequiredResult(primaryUser, secondaryUser, primarySummary, secondarySummary) {
  return {
    status: "merge_required",
    primaryUserUuid: primaryUser.user_uuid,
    secondaryUserUuid: secondaryUser.user_uuid,
    primaryCardCount: primarySummary.cardCount,
    secondaryCardCount: secondarySummary.cardCount,
  };
}

async function resolveTelegramToWebLink(targetUserUuid, { authUser }) {
  const targetUser = await getUserByUserUuid(targetUserUuid);
  if (!targetUser) {
    return { status: "not_found" };
  }

  const webUser = await getUserByAuthUserOrEmail(authUser);
  const authUserId = authUser?.id;
  const email = authUser?.email || null;

  if (targetUser.auth_user_id && String(targetUser.auth_user_id) !== String(authUserId)) {
    return { status: "target_has_other_web" };
  }

  if (!webUser || webUser.user_uuid === targetUser.user_uuid) {
    await setWebIdentityForVault(targetUser.user_uuid, { authUserId, email });
    await clearLinkTokensForVault(targetUser.user_uuid);
    return { status: webUser ? "already_linked" : "linked", userUuid: targetUser.user_uuid };
  }

  const targetSummary = await getVaultDataSummary(targetUser.user_uuid, { telegramId: targetUser.telegram_id });
  const webSummary = await getVaultDataSummary(webUser.user_uuid, { telegramId: webUser.telegram_id });

  if (targetSummary.hasData && webSummary.hasData) {
    return buildMergeRequiredResult(webUser, targetUser, webSummary, targetSummary);
  }

  if (targetSummary.hasData && !webSummary.hasData) {
    await deleteVaultShell(webUser);
    await setWebIdentityForVault(targetUser.user_uuid, { authUserId, email });
    await clearLinkTokensForVault(targetUser.user_uuid);
    return { status: "linked_removed_empty_web", userUuid: targetUser.user_uuid };
  }

  if (!targetSummary.hasData && webSummary.hasData) {
    if (targetUser.telegram_id) {
      await setTelegramIdForVault(webUser.user_uuid, {
        telegramId: targetUser.telegram_id,
        username: targetUser.username || null,
      });
    }
    await deleteVaultShell(targetUser);
    await clearLinkTokensForVault(webUser.user_uuid);
    return { status: "linked_existing_web", userUuid: webUser.user_uuid };
  }

  await deleteVaultShell(webUser);
  await setWebIdentityForVault(targetUser.user_uuid, { authUserId, email });
  await clearLinkTokensForVault(targetUser.user_uuid);
  return { status: "linked_removed_empty_web", userUuid: targetUser.user_uuid };
}

module.exports = {
  attachAuthUserToVault,
  createTelegramUser,
  createWebUser,
  backfillLinkedTelegramData,
  forgetUserByAuthUserId,
  forgetUserByTelegramId,
  getTelegramUserForLink,
  getVaultCardCount,
  getVaultCardCountByTelegramId,
  getUserByAuthUserId,
  getUserByAuthUserOrEmail,
  getUserByEmail,
  getUserByTelegramId,
  getUserByUserUuid,
  linkTelegramToWebVault,
  resolveTelegramToWebLink,
};
