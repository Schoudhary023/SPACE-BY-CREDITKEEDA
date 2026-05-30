const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { decryptForRuntime, encryptForRuntime } = require("./crypto");
const { extractGiftCardFromText, isAiParsingEnabled } = require("./aiParser");
const { normalizeExpiryDate, parseCardInput, sanitizeParsedCard } = require("./cardParser");
const { normalizeBrandKey } = require("./cardDisplay");
const { logError, logInfo, logWarn } = require("./logger");
const { escMd } = require("./markdown");
const { supabase, withSupabaseRetry } = require("./supabase");
const { track } = require("./analytics");
const { getUserByTelegramId, getUserByUserUuid } = require("./vaultUsers");
const {
  decryptCardSecrets,
  fetchCardsByUserUuid,
  saveCardForUserUuid,
} = require("./vaultCards");

const SUCCESS = "\u2705";
const WARNING = "\u26A0\uFE0F";
const ERROR = "\u274C";
const LOCK = "\u{1F510}";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_MESSAGES_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;
const DEFAULT_SYNC_LOOKBACK_DAYS = 30;
const DEFAULT_SYNC_OVERLAP_DAYS = 1;
const DEFAULT_SYNC_SAFETY_LIMIT = 1000;
const GMAIL_MAX_RESULTS_PER_PAGE = 500;
const MAX_PAGES_PER_QUERY = 5;
const GMAIL_API_FETCH_TIMEOUT_MS = 15_000;
const SYNC_REQUEST_BUDGET_MS = Math.max(
  5_000,
  Number(process.env.GMAIL_SYNC_REQUEST_BUDGET_MS) || 100_000
);
const GMAIL_SYNC_DEBUG_FLAG = String(process.env.GMAIL_SYNC_DEBUG || "").toLowerCase() === "true";
const GMAIL_SYNC_DEBUG = GMAIL_SYNC_DEBUG_FLAG && process.env.NODE_ENV !== "production";
if (GMAIL_SYNC_DEBUG_FLAG && !GMAIL_SYNC_DEBUG) {
  logWarn("GMAIL_SYNC_DEBUG=true ignored in production; refusing to write email PII to disk", {});
}
const GMAIL_SYNC_DEBUG_DIR = process.env.GMAIL_SYNC_DEBUG_DIR || path.join(process.cwd(), "gmail-sync-debug");

function buildRejectionRecord(messageId, mode, candidateText, extra = {}) {
  const text = String(candidateText || "");
  const subjectMatch = text.match(/^Subject:\s*(.+)$/m);
  const fromMatch = text.match(/^From:\s*(.+)$/m);
  const snippetMatch = text.match(/^Snippet:\s*([\s\S]+?)(?:\n\n|$)/);
  return {
    messageId,
    mode,
    subject: subjectMatch ? subjectMatch[1].slice(0, 200) : null,
    from: fromMatch ? fromMatch[1].slice(0, 120) : null,
    snippet: snippetMatch ? snippetMatch[1].slice(0, 240) : text.slice(0, 240),
    ...extra,
  };
}

function writeDebugReport(records, summary) {
  if (!GMAIL_SYNC_DEBUG || !records.length) return null;
  try {
    fs.mkdirSync(GMAIL_SYNC_DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(GMAIL_SYNC_DEBUG_DIR, `rejections-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify({ summary, rejections: records }, null, 2));
    logInfo("Gmail sync debug report written", { file, count: records.length });
    return file;
  } catch (error) {
    logWarn("Failed to write Gmail sync debug report", { error: error.message });
    return null;
  }
}
const DEFAULT_QUERY_LIST = [
  "\"gift card\"",
  "voucher",
  "\"claim code\"",
  "\"redemption code\"",
  "evoucher",
  "\"e-voucher\"",
];
const warnedGmailAiErrorCodes = new Set();
// Strong exclusions: emails that contain these signals are NOT gift cards
// (cashback, discount coupons, promo codes, loyalty points, etc.).
const EXCLUDED_EMAIL_PATTERNS = [
  // Cashback
  /\bcash\s*back\b/i,
  /\bcashback\b/i,
  /you['’]ve got this cashback/i,
  /\bcashback\s+(?:credited|earned|received|added|reward)/i,
  // Discount coupons / promo codes / off-deals
  /\bdiscount\s+coupon\b/i,
  /\bcoupon\s+code\b/i,
  /\bpromo\s+code\b/i,
  /\bpromocode\b/i,
  /\buse\s+code\s+\S+\s+(?:to|for|and)\s+(?:get|save|avail)/i,
  /\bflat\s+(?:rs\.?\s*)?\d+\s*(?:%|off|rupees|inr)/i,
  /\b\d+\s*%\s*off\b/i,
  /\bsave\s+(?:up\s+to\s+)?(?:rs\.?\s*)?\d+/i,
  /\bextra\s+(?:rs\.?\s*)?\d+\s*off\b/i,
  /\bdeal\s+of\s+the\s+(?:day|week)\b/i,
  /\blimited\s+time\s+offer\b/i,
  // Loyalty / reward points / referral
  /\b(?:reward|loyalty|membership)\s+points?\b/i,
  /\bpoints?\s+(?:credited|earned|expiring|balance)\b/i,
  /\breferral\s+(?:bonus|reward|credit)\b/i,
  /\binvite\s+(?:and|&)\s+earn\b/i,
  // Wallet credit / refund (not gift card)
  /\brefund\s+(?:initiated|processed|credited)\b/i,
  /\bwallet\s+(?:credit|recharge|top[-\s]?up)\b/i,
  // Bank statements / EMI / generic transactional
  /\bemi\s+(?:due|payment|reminder)\b/i,
  /\bstatement\s+is\s+ready\b/i,
];
const HARD_EXCLUDED_EMAIL_PATTERNS = [
  /\brefund\s+(?:for|of)\s+your\b/i,
  /\brefund\s+(?:initiated|processed|credited|applied)\b/i,
  /\bhas\s+been\s+applied\s+to\s+your\s+.+\bbalance\b/i,
  /\b(?:wallet|pay)\s+balance\b/i,
  /\badd\s+money\b/i,
  /\bview\s+statement\b/i,
  // Sign-in / OTP / verification emails — never gift cards even when the body
  // mentions one (e.g. our own app's OTP says "sign in to your gift card vault").
  /\bone[-\s]?time\s*(?:code|password|passcode|pin)\b/i,
  /\bsign[-\s]?in\s*code\b/i,
  /\bverification\s*code\b/i,
  /\b(?:login|log[-\s]?in)\s*(?:code|otp)\b/i,
  /\bauth(?:entication)?\s*code\b/i,
  /\bmagic\s*link\b/i,
  /\botp\s*(?:is|:)\b/i,
  /\byour\s+otp\b/i,
];

// Strict gift card / voucher signals. A bare word like "voucher" still counts
// (some legitimate emails say only "voucher code: XYZ") but the exclusion list
// above must not have matched first.
const GIFT_CARD_INTENT_PATTERNS = [
  /\bgift\s*card\b/i,
  /\be[-\s]?gift\s*card\b/i,
  /\bgift\s+voucher\b/i,
  /\be[-\s]?voucher\b/i,
  /\bevoucher\b/i,
  /\bvoucher\s+(?:code|pin|number|amount)\b/i,
  /\bgift\s+code\b/i,
  /\bclaim\s+code\b/i,
  /\bredemption\s+code\b/i,
  /\bredeem\s+(?:code|your\s+gift|your\s+voucher)\b/i,
  /\bgc\s*code\b/i,
  /\bgift\s*card\s+(?:pin|code|number|amount|balance)\b/i,
];
const JUNK_BRAND_PATTERN = /^(?:subject|from|snippet|hi|hello|thanks|paid|payment|amazon pay india|no-reply|noreply)$/i;
const JUNK_SECRET_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "has",
  "is",
  "on",
  "paid",
  "subject",
  "the",
  "this",
  "to",
  "was",
  "you",
  "your",
  "amount",
  "balance",
  "card",
  "claim",
  "code",
  "denomination",
  "details",
  "expiry",
  "fixed",
  "gift",
  "giftcard",
  "inr",
  "number",
  "payable",
  "pin",
  "redemption",
  "rs",
  "rupees",
  "till",
  "total",
  "until",
  "valid",
  "value",
  "voucher",
]);
const GIFT_CARD_LABEL_PATTERN = /(?:e[-\s]?gift\s*card|gift\s*card|gift\s*voucher|e[-\s]?voucher|evoucher|voucher)\s*(?:code|number|pin|details)?/i;
const CODE_LABEL_PATTERN = /\b(?:e[-\s]?gift\s*card\s*(?:code|number)|gift\s*card\s*(?:code|number)|voucher\s*(?:code|number)|claim\s*code|redemption\s*code|card\s*number)\b/i;
const PIN_LABEL_PATTERN = /\bpin\b/i;
const AMOUNT_LABEL_PATTERN = /\b(?:denomination|value|amount|gift\s*card\s*value|voucher\s*value)\b/i;
const EXPIRY_LABEL_PATTERN = /\b(?:valid\s*till|valid\s*until|expires?\s*(?:on)?|expiry|date\s*of\s*expiry)\b/i;
const PROMO_LINE_PATTERN = /\b(?:promo\s*code|coupon\s*code|discount\s*coupon|flat\s+\d+\s*%|%\s*off|off\s+on\s+mov)\b/i;
const BRAND_STOP_WORD_PATTERN = /^(?:your|gift|card|voucher|details|description|code|pin|value|denomination|valid|till|date|expiry|click|here|order|paid|cash|customer|dear|congratulations|thanks?|thank\s+you|instant|below|from|by|bank|smartbuy|gyftr|ishop|maximize)$/i;

function getGmailConfig() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID || "",
    clientSecret: process.env.GMAIL_CLIENT_SECRET || "",
    redirectUri: process.env.GMAIL_OAUTH_REDIRECT_URI || "",
    webSuccessUrl: process.env.SPACE_APP_URL || "/ui",
    syncLookbackDays: Math.max(1, Number(process.env.GMAIL_SYNC_LOOKBACK_DAYS) || DEFAULT_SYNC_LOOKBACK_DAYS),
    syncOverlapDays: Math.max(0, Number(process.env.GMAIL_SYNC_OVERLAP_DAYS) || DEFAULT_SYNC_OVERLAP_DAYS),
    syncSafetyLimit: Math.max(1, Number(process.env.GMAIL_SYNC_SAFETY_LIMIT) || DEFAULT_SYNC_SAFETY_LIMIT),
    customQuery: String(process.env.GMAIL_GIFT_CARD_QUERY || "").trim(),
  };
}

function isGmailSyncConfigured() {
  const config = getGmailConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

function isMissingSchemaError(error) {
  return error && error.code === "42P01";
}

function createOAuthStateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function formatGmailSearchDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function buildDateConstraint(value, config, since) {
  const hasDateConstraint = /\b(?:newer_than|older_than|after|before):/i.test(value);
  if (hasDateConstraint) return "";

  if (since) {
    const sinceMs = new Date(since).getTime();
    if (!Number.isNaN(sinceMs)) {
      const overlapMs = Math.max(0, config.syncOverlapDays || 0) * 24 * 60 * 60 * 1000;
      return ` after:${formatGmailSearchDate(new Date(sinceMs - overlapMs))}`;
    }
  }

  return ` newer_than:${config.syncLookbackDays}d`;
}

function addLookbackToQuery(query, config, since = null) {
  const normalizedConfig = typeof config === "number"
    ? { syncLookbackDays: config, syncOverlapDays: DEFAULT_SYNC_OVERLAP_DAYS }
    : config;
  const value = String(query || "").trim();
  const dateConstraint = buildDateConstraint(value, normalizedConfig, since);
  const chatConstraint = /\b-?in:chats\b/i.test(value) ? "" : " -in:chats";
  return `${value}${dateConstraint}${chatConstraint}`.trim();
}

function getGmailQueries(config = getGmailConfig(), since = null) {
  const queries = config.customQuery ? [config.customQuery] : DEFAULT_QUERY_LIST;
  return queries.map((query) => addLookbackToQuery(query, config, since));
}

function normalizeOwner(owner) {
  const userUuid = String(owner?.userUuid || owner?.user_uuid || "").trim();
  const telegramId = owner?.telegramId || owner?.telegram_id ? String(owner.telegramId || owner.telegram_id) : null;
  if (!userUuid) {
    throw new Error("Gmail owner userUuid is required");
  }

  return { userUuid, telegramId };
}

function ownerTrackId(owner) {
  return owner.telegramId || owner.userUuid;
}

function buildAuthUrl(stateToken) {
  const { clientId, redirectUri } = getGmailConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: `${GMAIL_SCOPE} openid email`,
    include_granted_scopes: "true",
    state: stateToken,
  });

  return `${GOOGLE_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

async function saveOAuthStateForOwner(ownerInput, stateToken, { chatId = null, source = "web" } = {}) {
  const owner = normalizeOwner(ownerInput);
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  const { error } = await withSupabaseRetry(() =>
    supabase.from("gmail_oauth_states_vault").upsert({
      state_token: stateToken,
      telegram_id: owner.telegramId,
      user_uuid: owner.userUuid,
      chat_id: chatId == null ? null : String(chatId),
      source,
      expires_at: expiresAt,
    }, { onConflict: "state_token" })
  );

  if (error) {
    throw error;
  }
}

async function saveOAuthState(telegramId, chatId, stateToken) {
  const user = await getUserByTelegramId(telegramId);
  await saveOAuthStateForOwner(
    { userUuid: user?.user_uuid, telegramId },
    stateToken,
    { chatId, source: "telegram" }
  );
}

async function consumeOAuthState(stateToken) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("gmail_oauth_states_vault")
      .select("state_token, telegram_id, user_uuid, chat_id, source, expires_at")
      .eq("state_token", stateToken)
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  await withSupabaseRetry(() =>
    supabase
      .from("gmail_oauth_states_vault")
      .delete()
      .eq("state_token", stateToken)
  );

  if (!data) {
    return null;
  }

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return data;
}

function serializeGmailAccountRow(data) {
  if (!data) {
    return null;
  }

  return {
    userUuid: data.user_uuid || null,
    telegramId: data.telegram_id == null ? null : String(data.telegram_id),
    emailAddress: data.email_address,
    accessToken: data.access_token_encrypted ? decryptForRuntime(data.access_token_encrypted) : null,
    refreshToken: data.refresh_token_encrypted ? decryptForRuntime(data.refresh_token_encrypted) : null,
    scope: data.scope || "",
    tokenExpiresAt: data.token_expires_at || null,
    lastSyncedAt: data.last_synced_at || null,
  };
}

async function getConnectedGmailAccountByOwner(ownerInput) {
  const owner = normalizeOwner(ownerInput);
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("gmail_accounts_vault")
      .select("telegram_id, user_uuid, email_address, access_token_encrypted, refresh_token_encrypted, scope, token_expires_at, last_synced_at")
      .eq("user_uuid", owner.userUuid)
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  return serializeGmailAccountRow(data);
}

async function getConnectedGmailAccount(telegramId) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("gmail_accounts_vault")
      .select("telegram_id, user_uuid, email_address, access_token_encrypted, refresh_token_encrypted, scope, token_expires_at, last_synced_at")
      .eq("telegram_id", String(telegramId))
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  return serializeGmailAccountRow(data);
}

async function disconnectGmailForOwner(ownerInput, { clearProcessed = true } = {}) {
  const owner = normalizeOwner(ownerInput);
  const filters = (query) => {
    if (owner.telegramId) {
      return query.or(`user_uuid.eq.${owner.userUuid},telegram_id.eq.${owner.telegramId}`);
    }
    return query.eq("user_uuid", owner.userUuid);
  };
  const account = await getConnectedGmailAccountByOwner(owner);
  await revokeGoogleTokenForAccount(account, owner);

  const { error: accountError } = await withSupabaseRetry(() =>
    filters(supabase.from("gmail_accounts_vault").delete())
  );
  if (accountError && !isMissingSchemaError(accountError)) throw accountError;

  const { error: stateError } = await withSupabaseRetry(() =>
    filters(supabase.from("gmail_oauth_states_vault").delete())
  );
  if (stateError && !isMissingSchemaError(stateError)) throw stateError;

  if (clearProcessed) {
    const { error: processedError } = await withSupabaseRetry(() =>
      filters(supabase.from("gmail_processed_messages_vault").delete())
    );
    if (processedError && !isMissingSchemaError(processedError)) throw processedError;
  }
}

async function revokeGoogleToken(token) {
  const response = await fetch(GOOGLE_REVOKE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`Google token revoke failed: ${response.status} ${body.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
}

async function revokeGoogleTokenForAccount(account, owner) {
  if (!account) return;

  const token = account.refreshToken || account.accessToken;
  if (!token) return;

  try {
    await revokeGoogleToken(token);
  } catch (error) {
    logWarn("Failed to revoke Google OAuth token during Gmail disconnect", {
      userUuid: owner.userUuid,
      email: account.emailAddress || null,
      status: error.status || null,
      error: error.message,
    });
  }
}

async function upsertConnectedGmailAccountForOwner(ownerInput, account) {
  const owner = normalizeOwner(ownerInput);
  const row = {
    telegram_id: owner.telegramId,
    user_uuid: owner.userUuid,
    email_address: account.emailAddress,
    access_token_encrypted: encryptForRuntime(account.accessToken),
    refresh_token_encrypted: account.refreshToken ? encryptForRuntime(account.refreshToken) : null,
    scope: account.scope || "",
    token_expires_at: account.tokenExpiresAt || null,
    last_synced_at: account.lastSyncedAt || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await withSupabaseRetry(() =>
    supabase.from("gmail_accounts_vault").upsert(row, { onConflict: "user_uuid" })
  );

  if (error) {
    throw error;
  }
}

async function upsertConnectedGmailAccount(telegramId, account) {
  const user = await getUserByTelegramId(telegramId);
  await upsertConnectedGmailAccountForOwner({ userUuid: user?.user_uuid, telegramId }, account);
}

async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = getGmailConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error_description || payload?.error || "Google token exchange failed");
    error.code = "GMAIL_TOKEN_EXCHANGE_FAILED";
    throw error;
  }

  return payload;
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getGmailConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error_description || payload?.error || "Google token refresh failed");
    error.code = "GMAIL_TOKEN_REFRESH_FAILED";
    throw error;
  }

  return payload;
}

async function fetchGmailProfile(accessToken) {
  const response = await fetch(GMAIL_PROFILE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "Failed to fetch Gmail profile");
    error.code = "GMAIL_PROFILE_FAILED";
    error.status = response.status;
    throw error;
  }

  return payload;
}

function computeTokenExpiry(expiresInSeconds) {
  if (!Number.isFinite(Number(expiresInSeconds))) {
    return null;
  }

  return new Date(Date.now() + (Number(expiresInSeconds) * 1000)).toISOString();
}

async function ensureFreshAccessTokenForOwner(ownerInput, account) {
  const owner = normalizeOwner(ownerInput);
  if (!account?.refreshToken) {
    throw new Error("No Gmail refresh token is stored for this account");
  }

  const expiresAtMs = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (account.accessToken && expiresAtMs > Date.now() + ACCESS_TOKEN_SKEW_MS) {
    return account.accessToken;
  }

  const refreshed = await refreshAccessToken(account.refreshToken);
  const nextAccount = {
    ...account,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || account.refreshToken,
    scope: refreshed.scope || account.scope || "",
    tokenExpiresAt: computeTokenExpiry(refreshed.expires_in),
  };

  await upsertConnectedGmailAccountForOwner(owner, nextAccount);
  return nextAccount.accessToken;
}

async function ensureFreshAccessToken(telegramId, account) {
  const user = await getUserByTelegramId(telegramId);
  return ensureFreshAccessTokenForOwner({ userUuid: user?.user_uuid, telegramId }, account);
}

function buildHtmlResponse(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;max-width:640px;margin:40px auto;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
}

function buildRedirectHtmlResponse(title, body, redirectUrl) {
  const safeRedirectUrl = String(redirectUrl || "/ui").replace(/[\u0000-\u001F\u007F]/g, "");
  const safeRedirectAttr = escapeHtml(safeRedirectUrl).replace(/"/g, "&quot;");
  const safeRedirectScript = JSON.stringify(safeRedirectUrl);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta http-equiv="refresh" content="1;url=${safeRedirectAttr}"></head><body style="font-family:Arial,sans-serif;max-width:640px;margin:40px auto;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${body}</p><p>Returning to Space...</p><script>setTimeout(function(){ window.location.href = ${safeRedirectScript}; }, 900);</script></body></html>`;
}

function buildPopupCloseHtmlResponse(title, body) {
  const msg = JSON.stringify({ type: "gmail_oauth", status: "connected" });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;max-width:640px;margin:40px auto;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${body}</p><p>You can close this tab and return to Space.</p><script>try{if(window.opener&&!window.opener.closed){window.opener.postMessage(${msg},"*");window.close();}}catch(e){}</script></body></html>`;
}

async function beginGmailConnect(bot, chatId, telegramId) {
  if (!isGmailSyncConfigured()) {
    await bot.sendMessage(
      chatId,
      `${WARNING} Gmail sync is not configured on the server yet\\. Add the Gmail OAuth env vars first\\.`,
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  try {
    const stateToken = createOAuthStateToken();
    await saveOAuthState(telegramId, chatId, stateToken);
    const authUrl = buildAuthUrl(stateToken);

    await bot.sendMessage(
      chatId,
      [
        `${LOCK} Connect your Gmail to import gift cards from email\\.`,
        `[Tap here to connect Gmail](${authUrl})`,
        "After Google says the connection is complete, come back here and send /gmail\\_sync again to start the import\\.",
      ].join("\n\n"),
      {
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      await bot.sendMessage(
        chatId,
        `${WARNING} Gmail sync tables are missing in Supabase\\. Run scripts/migrate-gmail-sync\\.sql first\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    throw error;
  }
}

async function beginGmailConnectForWeb(userUuid) {
  if (!isGmailSyncConfigured()) {
    const error = new Error("Gmail sync is not configured");
    error.code = "GMAIL_NOT_CONFIGURED";
    throw error;
  }

  const user = await getUserByUserUuid(userUuid);
  if (!user) {
    const error = new Error("Vault user not found");
    error.code = "GMAIL_USER_NOT_FOUND";
    throw error;
  }

  const stateToken = createOAuthStateToken();
  await saveOAuthStateForOwner({ userUuid: user.user_uuid, telegramId: user.telegram_id || null }, stateToken, {
    source: "web",
  });

  return {
    authUrl: buildAuthUrl(stateToken),
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function handleGmailOAuthCallback(bot, req, res, requestUrl) {
  if (!isGmailSyncConfigured()) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buildHtmlResponse("Gmail sync unavailable", "The server is not configured for Gmail OAuth yet."));
    return true;
  }

  const code = requestUrl.searchParams.get("code");
  const stateToken = requestUrl.searchParams.get("state");
  const oauthError = requestUrl.searchParams.get("error");

  if (oauthError) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buildHtmlResponse("Gmail connection cancelled", `Google returned: ${escapeHtml(oauthError)}`));
    return true;
  }

  if (!code || !stateToken) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buildHtmlResponse("Invalid request", "Missing OAuth code or state."));
    return true;
  }

  let pendingState = null;
  try {
    pendingState = await consumeOAuthState(stateToken);
    if (!pendingState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buildHtmlResponse("Link expired", "This Gmail connect link has expired. Return to Space and try connecting Gmail again."));
      return true;
    }

    const tokens = await exchangeCodeForTokens(code);
    const profile = await fetchGmailProfile(tokens.access_token);
    const owner = {
      userUuid: pendingState.user_uuid,
      telegramId: pendingState.telegram_id || null,
    };
    const existing = await getConnectedGmailAccountByOwner(owner);

    await upsertConnectedGmailAccountForOwner(owner, {
      emailAddress: profile.emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || existing?.refreshToken || null,
      scope: tokens.scope || "",
      tokenExpiresAt: computeTokenExpiry(tokens.expires_in),
      lastSyncedAt: existing?.lastSyncedAt || null,
    });

    track("gmail.connected", ownerTrackId(owner), { email_domain: String(profile.emailAddress || "").split("@")[1] || null });
    if (pendingState.source !== "web" && pendingState.chat_id && bot) {
      await bot.sendMessage(
        Number(pendingState.chat_id),
        `${SUCCESS} Gmail connected for *${escMd(profile.emailAddress)}*\\. Send /gmail\\_sync again to scan and import active gift cards\\.`,
        { parse_mode: "MarkdownV2" }
      ).catch((error) => {
        logWarn("Failed to notify Telegram chat after Gmail connect", { telegramId: pendingState.telegram_id, error: error.message });
      });
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const successBody = pendingState.source === "web"
      ? `Gmail connected for ${escapeHtml(profile.emailAddress)}. Returning to Space now.`
      : `Gmail connected for ${escapeHtml(profile.emailAddress)}. Return to Space to import gift cards.`;
    res.end(
      pendingState.source === "web"
        ? buildRedirectHtmlResponse("Gmail connected", successBody, `${getGmailConfig().webSuccessUrl}?gmail=connected`)
        : buildHtmlResponse("Gmail connected", successBody)
    );
    return true;
  } catch (error) {
    logError("Gmail OAuth callback failed", error);
    const destination = pendingState?.source === "web"
      ? "Return to Space and try connecting Gmail again."
      : "Return to Space and try connecting Gmail again.";
    const body = isMissingSchemaError(error)
      ? "The Gmail sync tables are missing. Run the Gmail migration and try again."
      : `Gmail could not be connected right now. ${destination}`;
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buildHtmlResponse("Connection failed", body));
    return true;
  }
}

async function gmailApiGetJson(path, accessToken, searchParams = null) {
  const url = new URL(path, `${GMAIL_MESSAGES_ENDPOINT}/`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value != null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(GMAIL_API_FETCH_TIMEOUT_MS),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "Gmail API request failed");
    error.code = "GMAIL_API_FAILED";
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function fetchProcessedMessageIdsForOwner(ownerInput) {
  const owner = normalizeOwner(ownerInput);
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("gmail_processed_messages_vault")
      .select("gmail_message_id")
      .eq("user_uuid", owner.userUuid)
  );

  if (error) {
    throw error;
  }

  return new Set((data || []).map((row) => String(row.gmail_message_id)));
}

async function fetchProcessedMessageIds(telegramId) {
  const user = await getUserByTelegramId(telegramId);
  return fetchProcessedMessageIdsForOwner({ userUuid: user?.user_uuid, telegramId });
}

async function markMessagesProcessedForOwner(ownerInput, messageIds) {
  if (!messageIds.length) {
    return;
  }

  const owner = normalizeOwner(ownerInput);
  const rows = messageIds.map((messageId) => ({
    telegram_id: owner.telegramId,
    user_uuid: owner.userUuid,
    gmail_message_id: String(messageId),
    processed_at: new Date().toISOString(),
  }));

  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("gmail_processed_messages_vault")
      .upsert(rows, { onConflict: "user_uuid,gmail_message_id" })
  );

  if (error) {
    throw error;
  }
}

async function markMessagesProcessed(telegramId, messageIds) {
  const user = await getUserByTelegramId(telegramId);
  return markMessagesProcessedForOwner({ userUuid: user?.user_uuid, telegramId }, messageIds);
}

async function collectCandidateMessageIdsForOwner(accessToken, ownerInput, config = getGmailConfig(), options = {}) {
  const owner = normalizeOwner(ownerInput);
  const ids = [];
  const seenIds = new Set();
  const processedIds = await fetchProcessedMessageIdsForOwner(owner);
  const queries = getGmailQueries(config, options.since || null);
  const safetyLimit = config.syncSafetyLimit;

  for (const query of queries) {
    if (ids.length >= safetyLimit) {
      break;
    }

    let nextPageToken = null;
    let pageCount = 0;

    while (ids.length < safetyLimit && pageCount < MAX_PAGES_PER_QUERY) {
      const payload = await gmailApiGetJson(".", accessToken, {
        q: query,
        maxResults: GMAIL_MAX_RESULTS_PER_PAGE,
        pageToken: nextPageToken,
      });

      for (const message of payload.messages || []) {
        const messageId = String(message.id);
        if (seenIds.has(messageId) || processedIds.has(messageId)) {
          continue;
        }

        seenIds.add(messageId);
        ids.push(messageId);
        if (ids.length >= safetyLimit) {
          break;
        }
      }

      nextPageToken = payload.nextPageToken || null;
      pageCount += 1;
      if (!nextPageToken) {
        break;
      }
    }
  }

  return ids.slice(0, safetyLimit);
}

async function collectCandidateMessageIds(accessToken, telegramId, config = getGmailConfig()) {
  const user = await getUserByTelegramId(telegramId);
  return collectCandidateMessageIdsForOwner(accessToken, { userUuid: user?.user_uuid, telegramId }, config);
}

function decodeBase64Url(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getHeader(payload, name) {
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const match = headers.find((header) => String(header.name || "").toLowerCase() === String(name).toLowerCase());
  return match?.value || "";
}

function collectBodyParts(payload, bag = { plain: [], html: [] }) {
  if (!payload) {
    return bag;
  }

  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if ((payload.mimeType || "").startsWith("text/plain")) {
      bag.plain.push(decoded);
    } else if ((payload.mimeType || "").startsWith("text/html")) {
      bag.html.push(decoded);
    }
  }

  for (const part of payload.parts || []) {
    collectBodyParts(part, bag);
  }

  return bag;
}

function buildMessageCandidateText(message) {
  const payload = message?.payload || {};
  const bodyParts = collectBodyParts(payload);
  const subject = getHeader(payload, "Subject");
  const from = getHeader(payload, "From");
  const snippet = message?.snippet || "";
  const plainText = bodyParts.plain.join("\n\n");
  const htmlText = stripHtml(bodyParts.html.join("\n\n"));

  return [
    subject ? `Subject: ${subject}` : "",
    from ? `From: ${from}` : "",
    snippet ? `Snippet: ${snippet}` : "",
    plainText,
    htmlText,
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 12000);
}

function shouldExcludeEmailText(text) {
  const value = String(text || "");
  return HARD_EXCLUDED_EMAIL_PATTERNS.some((pattern) => pattern.test(value)) ||
    EXCLUDED_EMAIL_PATTERNS.some((pattern) => pattern.test(value));
}

function shouldHardExcludeEmailText(text) {
  const value = String(text || "");
  return HARD_EXCLUDED_EMAIL_PATTERNS.some((pattern) => pattern.test(value));
}

function findExclusionMatch(text) {
  const value = String(text || "");
  for (const pattern of HARD_EXCLUDED_EMAIL_PATTERNS) {
    if (pattern.test(value)) {
      return { pattern: pattern.source, hard: true };
    }
  }
  for (const pattern of EXCLUDED_EMAIL_PATTERNS) {
    if (pattern.test(value)) {
      return { pattern: pattern.source, hard: false };
    }
  }
  return null;
}

function hasGiftCardIntent(text) {
  const value = String(text || "");
  return GIFT_CARD_INTENT_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeEmailLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function valueAfterLabel(line, labelPattern) {
  const value = String(line || "");
  const match = value.match(labelPattern);
  if (!match) return null;
  return value.slice(match.index + match[0].length).replace(/^[\s:：\-–—]+/, "").trim() || null;
}

function findLabeledValue(lines, labelPattern, valuePattern, { startIndex = 0, maxLookahead = 3 } = {}) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!labelPattern.test(line)) continue;

    const sameLine = valueAfterLabel(line, labelPattern);
    const sameLineMatch = sameLine && sameLine.match(valuePattern);
    if (sameLineMatch) return { value: sameLineMatch[1] || sameLineMatch[0], index };

    for (let lookahead = 1; lookahead <= maxLookahead && index + lookahead < lines.length; lookahead += 1) {
      const candidate = lines[index + lookahead];
      if (PROMO_LINE_PATTERN.test(candidate)) break;
      const match = candidate.match(valuePattern);
      if (match) return { value: match[1] || match[0], index: index + lookahead };
    }
  }
  return null;
}

function extractAmountFromText(value) {
  const text = String(value || "");
  const patterns = [
    /(?:inr|rs\.?|₹)\s*([0-9][0-9,]*(?:\.\d+)?)/i,
    /([0-9][0-9,]*(?:\.\d+)?)\s*(?:inr|rs\.?|₹)/i,
    /\b([0-9][0-9,]*(?:\.\d+)?)\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = Number(String(match[1]).replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return null;
}

function cleanBrandCandidate(value) {
  const cleaned = String(value || "")
    .replace(/subject:\s*/ig, "")
    .replace(/\([^)]*(?:inr|rs\.?|₹)[^)]*\)/ig, " ")
    .replace(/\b(?:inr|rs\.?|₹)\s*[0-9][0-9,]*(?:\.\d+)?\b/ig, " ")
    .replace(/\b[0-9][0-9,]*(?:\.\d+)?\s*(?:inr|rs\.?)\b/ig, " ")
    .replace(/\be[-\s]?gift\s*card\s*(?:code|number)?\b/ig, " ")
    .replace(/\bgift\s*card\s*(?:code|number)?\b/ig, " ")
    .replace(/\be[-\s]?voucher\b/ig, " ")
    .replace(/\bvoucher\b/ig, " ")
    .replace(/\bpromo\s*code\b/ig, " ")
    .replace(/\b(?:value|denomination|pin|valid till|date of expiry|details|description)\b/ig, " ")
    .replace(/^[₹$€£]\s*[0-9][0-9,]*(?:\.\d+)?$/ig, " ")
    .replace(/[:|()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length > 80 || /@|<|>/.test(cleaned)) return null;
  if (/^[₹$€£]?\s*[0-9][0-9,]*(?:\.\d+)?$/.test(cleaned)) return null;
  if (/[.!?]$/.test(cleaned) && cleaned.split(/\s+/).length > 4) return null;
  const words = cleaned.split(/\s+/).filter((word) => !BRAND_STOP_WORD_PATTERN.test(word));
  return words.length ? words.join(" ").trim() : null;
}

function scoreBrandLine(line, distanceFromCode) {
  const value = String(line || "");
  if (!value || PROMO_LINE_PATTERN.test(value)) return -100;
  if (CODE_LABEL_PATTERN.test(value) || PIN_LABEL_PATTERN.test(value) || EXPIRY_LABEL_PATTERN.test(value)) return -100;
  if (!cleanBrandCandidate(value)) return -100;

  let score = Math.max(0, 20 - distanceFromCode);
  if (/(?:inr|rs\.?|₹)\s*[0-9]/i.test(value) || /[0-9]\s*(?:inr|rs\.?)/i.test(value)) score += 30;
  if (GIFT_CARD_LABEL_PATTERN.test(value)) score += 20;
  if (/^\s*(?:[A-Z][A-Za-z0-9&.'-]*)(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3}\s*$/.test(value)) score += 25;
  if (/^[A-Z][A-Za-z0-9&.' -]{1,50}$/.test(value)) score += 8;
  if (/thank|congratulations|buying|purchase|successfully|below|via|bank|smartbuy/i.test(value)) score -= 50;
  if (/\border\b/i.test(value)) score -= 20;
  return score;
}

function inferVoucherBrand(lines, codeIndex, amount) {
  const start = Math.max(0, codeIndex - 8);
  const end = Math.min(lines.length - 1, codeIndex + 8);
  let best = null;

  for (let index = start; index <= end; index += 1) {
    const brand = cleanBrandCandidate(lines[index]);
    if (!brand) continue;
    let score = scoreBrandLine(lines[index], Math.abs(index - codeIndex));
    if (amount && String(lines[index]).includes(String(Math.trunc(amount)))) score += 15;
    if (index < codeIndex) score += 4;
    if (!best || score > best.score) best = { brand, score };
  }
  return best && best.score > 0 ? best.brand : null;
}

function parseGenericVoucherEmail(text) {
  const lines = normalizeEmailLines(text);
  if (!lines.length || !hasGiftCardIntent(text)) return null;

  const codeResult = findLabeledValue(lines, CODE_LABEL_PATTERN, /\b([A-Z0-9][A-Z0-9 -]{3,79})\b/i, { maxLookahead: 4 });
  if (!codeResult) return null;

  const code = String(codeResult.value || "").replace(/\s+/g, "").trim();
  if (!isPlausibleSecret(code, { minLength: 4, maxLength: 80 })) return null;

  const pinResult = findLabeledValue(lines, PIN_LABEL_PATTERN, /\b([A-Z0-9][A-Z0-9 -]{2,31})\b/i, {
    startIndex: Math.max(0, codeResult.index - 2),
    maxLookahead: 3,
  });
  const pin = pinResult ? String(pinResult.value || "").replace(/\s+/g, "").trim() : null;

  const amountResult = findLabeledValue(lines, AMOUNT_LABEL_PATTERN, /(?:inr|rs\.?|₹)?\s*([0-9][0-9,]*(?:\.\d+)?)/i, {
    startIndex: Math.max(0, codeResult.index - 8),
    maxLookahead: 4,
  });
  let amount = amountResult ? extractAmountFromText(amountResult.value) : null;
  if (!amount) {
    amount = extractAmountFromText(lines.slice(Math.max(0, codeResult.index - 8), Math.min(lines.length, codeResult.index + 6)).join(" "));
  }

  const expiryResult = findLabeledValue(
    lines,
    EXPIRY_LABEL_PATTERN,
    /\b(\d{1,2}(?:st|nd|rd|th)?[\s/-]+[A-Za-z]{3,9}[\s/-]+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2})\b/i,
    { startIndex: Math.max(0, codeResult.index - 2), maxLookahead: 4 }
  );
  const expiryDate = expiryResult ? normalizeExpiryDate(expiryResult.value) : null;
  const brand = inferVoucherBrand(lines, codeResult.index, amount);

  return sanitizeParsedCard({ brand, amount, code, pin, expiryDate, confidence: 0.9 }, { minConfidence: 0.7 });
}

async function fetchMessage(accessToken, messageId) {
  return gmailApiGetJson(`./${encodeURIComponent(messageId)}`, accessToken, {
    format: "full",
  });
}

async function parseGiftCardFromEmailText(text) {
  // Hard rejection first: cashback, discount coupons, promo codes, loyalty
  // points, refunds — these are never gift cards.
  if (shouldHardExcludeEmailText(text) || (shouldExcludeEmailText(text) && !hasGiftCardIntent(text))) {
    const match = findExclusionMatch(text);
    return { card: null, mode: "excluded", excludedBy: match ? match.pattern : null };
  }

  if (!hasGiftCardIntent(text)) {
    return { card: null, mode: "filtered" };
  }

  const genericVoucher = parseGenericVoucherEmail(text);
  if (genericVoucher && validateEmailParsedCard(genericVoucher)) {
    return { card: genericVoucher, mode: "generic" };
  }

  const basicParsed = parseCardInput(text);
  if (basicParsed && validateEmailParsedCard(basicParsed)) {
    return { card: basicParsed, mode: "local" };
  }

  if (!isAiParsingEnabled()) {
    return { card: null, mode: "failed" };
  }

  let aiRaw;
  try {
    aiRaw = await extractGiftCardFromText(text);
  } catch (error) {
    if (String(error?.code || "").startsWith("VERTEX_")) {
      const warningKey = `${error.code || "VERTEX_ERROR"}:${error.status || ""}`;
      if (!warnedGmailAiErrorCodes.has(warningKey)) {
        warnedGmailAiErrorCodes.add(warningKey);
        logWarn("Gmail AI parser unavailable; falling back to local email parsing only", {
          code: error.code,
          status: error.status || null,
          error: error.message,
        });
      }
      return { card: null, mode: "ai_unavailable" };
    }

    throw error;
  }

  const parsed = sanitizeParsedCard(aiRaw, { minConfidence: 0.7 });
  if (parsed && !validateEmailParsedCard(parsed)) {
    logInfo("Rejected implausible Gmail parse", {
      hasBrand: Boolean(parsed.brand),
      hasAmount: Number.isFinite(Number(parsed.amount)),
      codeLength: String(parsed.code || "").length,
      pinLength: parsed.pin ? String(parsed.pin).length : 0,
      confidence: typeof aiRaw?.confidence === "number" ? aiRaw.confidence : null,
    });
    return { card: null, mode: "rejected" };
  }

  return {
    card: parsed,
    mode: parsed ? "vertex" : "failed",
  };
}

function normalizeGiftCardCode(code) {
  return String(code || "").trim();
}

function isPlausibleSecret(value, { minLength, maxLength, allowNull = false, requireDigit = true } = {}) {
  if (value == null || value === "") return Boolean(allowNull);
  const normalized = String(value).trim();
  const compact = normalized.replace(/[\s-]/g, "");
  if (compact.length < minLength || compact.length > maxLength) return false;
  if (!/^[a-z0-9-]+$/i.test(normalized)) return false;
  if (JUNK_SECRET_WORDS.has(compact.toLowerCase())) return false;
  if (requireDigit && !/\d/.test(compact)) return false;
  return true;
}

function validateEmailParsedCard(card) {
  if (!card) return false;

  const brand = String(card.brand || "").trim();
  if (!brand || JUNK_BRAND_PATTERN.test(brand) || /[:@<>]/.test(brand)) {
    return false;
  }

  if (!Number.isFinite(Number(card.amount)) || Number(card.amount) <= 0) {
    return false;
  }

  if (!isPlausibleSecret(card.code, { minLength: 4, maxLength: 80 })) {
    return false;
  }

  if (!isPlausibleSecret(card.pin, { minLength: 3, maxLength: 32, allowNull: true })) {
    card.pin = null;
  }

  return true;
}

function buildFingerprint(brand, code) {
  return `${normalizeBrandKey(brand)}:${normalizeGiftCardCode(code)}`;
}

function isExpired(expiryDate) {
  if (!expiryDate) {
    return false;
  }

  const today = new Date();
  const todayIso = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  return expiryDate < todayIso;
}

async function buildExistingFingerprintSetForOwner(ownerInput, vaultPin, encryptionSalt) {
  const owner = normalizeOwner(ownerInput);
  const cards = await fetchCardsByUserUuid(owner.userUuid, { includeRedeemed: true });
  const fingerprints = new Set();

  for (const card of cards) {
    try {
      const { decryptedCode: code } = await decryptCardSecrets(card, vaultPin, encryptionSalt);
      fingerprints.add(buildFingerprint(card.brand, code));
    } catch (error) {
      logWarn("Skipping existing card during Gmail duplicate check", { userUuid: owner.userUuid, cardId: card.id, error: error.message });
    }
  }

  return fingerprints;
}

async function buildExistingFingerprintSet(telegramId, vaultPin, encryptionSalt) {
  const user = await getUserByTelegramId(telegramId);
  return buildExistingFingerprintSetForOwner({ userUuid: user?.user_uuid, telegramId }, vaultPin, encryptionSalt);
}

async function saveImportedCardForOwner(ownerInput, vaultPin, encryptionSalt, parsed, sourceLabel) {
  const owner = normalizeOwner(ownerInput);
  const inserted = await saveCardForUserUuid(owner.userUuid, vaultPin, encryptionSalt, parsed, sourceLabel);
  return inserted.id;
}

async function saveImportedCard(telegramId, vaultPin, encryptionSalt, parsed, sourceLabel) {
  const user = await getUserByTelegramId(telegramId);
  return saveImportedCardForOwner({ userUuid: user?.user_uuid, telegramId }, vaultPin, encryptionSalt, parsed, sourceLabel);
}

async function markLastSyncedAtForOwner(ownerInput) {
  const owner = normalizeOwner(ownerInput);
  const nowIso = new Date().toISOString();
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("gmail_accounts_vault")
      .update({
        last_synced_at: nowIso,
        updated_at: nowIso,
      })
      .eq("user_uuid", owner.userUuid)
  );

  if (error) {
    throw error;
  }
}

async function markLastSyncedAt(telegramId) {
  const user = await getUserByTelegramId(telegramId);
  return markLastSyncedAtForOwner({ userUuid: user?.user_uuid, telegramId });
}

async function completeGmailSyncForOwner(ownerInput, messageIds = []) {
  const normalizedIds = [...new Set((Array.isArray(messageIds) ? messageIds : [])
    .map((messageId) => String(messageId || "").trim())
    .filter(Boolean))]
    .slice(0, getGmailConfig().syncSafetyLimit);

  await markMessagesProcessedForOwner(ownerInput, normalizedIds);
  await markLastSyncedAtForOwner(ownerInput);

  return {
    completed: true,
    processedMessages: normalizedIds.length,
  };
}

function buildSyncSummary(account, summary) {
  const lines = [
    `${SUCCESS} Gmail sync finished for *${escMd(account.emailAddress)}*\\.`,
    `Scanned: *${escMd(summary.scannedMessages)}* email${summary.scannedMessages === 1 ? "" : "s"}`,
    `Imported: *${escMd(summary.imported)}* new gift card${summary.imported === 1 ? "" : "s"}`,
  ];

  if (summary.duplicates > 0) {
    lines.push(`Skipped duplicates: *${escMd(summary.duplicates)}*`);
  }

  if (summary.expired > 0) {
    lines.push(`Skipped expired: *${escMd(summary.expired)}*`);
  }

  if (summary.unparsed > 0) {
    lines.push(`No reliable parse: *${escMd(summary.unparsed)}*`);
  }

  lines.push("");
  lines.push("Use /show, /search, and expiry alerts as usual\\.");
  return lines.join("\n");
}

async function runGmailSync(bot, msg, session) {
  await bot.sendMessage(
    msg.chat.id,
    `${WARNING} Gmail sync is now supported in Space web only\\. Open Space to connect Gmail and import gift cards\\.`,
    { parse_mode: "MarkdownV2" }
  );
  void session;
}

async function getGmailStatusForUserUuid(userUuid) {
  if (!isGmailSyncConfigured()) {
    return {
      configured: false,
      connected: false,
      account: null,
    };
  }

  const user = await getUserByUserUuid(userUuid);
  if (!user) {
    return {
      configured: true,
      connected: false,
      account: null,
    };
  }

  const account = await getConnectedGmailAccountByOwner({
    userUuid: user.user_uuid,
    telegramId: user.telegram_id || null,
  });

  return {
    configured: true,
    connected: Boolean(account),
    account: account
      ? {
          emailAddress: account.emailAddress,
          scope: account.scope,
          tokenExpiresAt: account.tokenExpiresAt,
          lastSyncedAt: account.lastSyncedAt,
        }
      : null,
  };
}

async function runGmailSyncForOwner(ownerInput, session = {}) {
  if (!isGmailSyncConfigured()) {
    const error = new Error("Gmail sync is not configured");
    error.code = "GMAIL_NOT_CONFIGURED";
    throw error;
  }

  const owner = normalizeOwner(ownerInput);
  const account = await getConnectedGmailAccountByOwner(owner);
  if (!account) {
    const error = new Error("Gmail account is not connected");
    error.code = "GMAIL_NOT_CONNECTED";
    throw error;
  }

  const accessToken = await ensureFreshAccessTokenForOwner(owner, account);
  const gmailConfig = getGmailConfig();
  const messageIds = await collectCandidateMessageIdsForOwner(accessToken, owner, gmailConfig, {
    since: account.lastSyncedAt || null,
  });
  const shouldSave = session.save !== false;
  const existingFingerprints = shouldSave
    ? await buildExistingFingerprintSetForOwner(owner, session.vaultPin, session.encryptionSalt)
    : new Set();
  const summary = {
    emailAddress: account.emailAddress,
    lookbackDays: gmailConfig.syncLookbackDays,
    scannedMessages: 0,
    totalCandidates: messageIds.length,
    truncated: false,
    imported: 0,
    duplicates: 0,
    expired: 0,
    unparsed: 0,
    cards: [],
    processedMessageIds: [],
    rejections: {
      empty: 0,
      excluded: 0,
      filtered: 0,
      failed: 0,
      ai_unavailable: 0,
      fetch_error: 0,
    },
  };

  const debugRecords = [];
  const deadline = Date.now() + SYNC_REQUEST_BUDGET_MS;
  for (const messageId of messageIds) {
    if (Date.now() >= deadline) {
      summary.truncated = true;
      break;
    }
    summary.scannedMessages += 1;
    summary.processedMessageIds.push(messageId);
    try {
      const message = await fetchMessage(accessToken, messageId);
      const candidateText = buildMessageCandidateText(message);
      if (!candidateText) {
        summary.unparsed += 1;
        summary.rejections.empty += 1;
        if (GMAIL_SYNC_DEBUG) debugRecords.push(buildRejectionRecord(messageId, "empty", ""));
        continue;
      }

      const parseResult = await parseGiftCardFromEmailText(candidateText);
      const parsed = parseResult.card;
      if (!parsed) {
        summary.unparsed += 1;
        const reasonKey = parseResult.mode in summary.rejections ? parseResult.mode : "failed";
        summary.rejections[reasonKey] += 1;
        if (GMAIL_SYNC_DEBUG) {
          debugRecords.push(buildRejectionRecord(messageId, parseResult.mode, candidateText, {
            excludedBy: parseResult.excludedBy || null,
          }));
        }
        continue;
      }

      if (isExpired(parsed.expiryDate)) {
        summary.expired += 1;
        continue;
      }

      const fingerprint = buildFingerprint(parsed.brand, parsed.code);
      if (existingFingerprints.has(fingerprint)) {
        summary.duplicates += 1;
        continue;
      }

      if (shouldSave) {
        await saveImportedCardForOwner(owner, session.vaultPin, session.encryptionSalt, parsed, `gmail_${parseResult.mode}`);
      } else {
        summary.cards.push(parsed);
      }
      existingFingerprints.add(fingerprint);
      summary.imported += 1;
    } catch (error) {
      logWarn("Gmail message skipped during sync", { userUuid: owner.userUuid, messageId, error: error.message });
      summary.unparsed += 1;
      summary.rejections.fetch_error += 1;
    }
  }

  if (shouldSave) {
    await completeGmailSyncForOwner(owner, summary.processedMessageIds);
  }
  if (GMAIL_SYNC_DEBUG) {
    summary.debugReportPath = writeDebugReport(debugRecords, {
      emailAddress: summary.emailAddress,
      scannedMessages: summary.scannedMessages,
      rejections: summary.rejections,
    });
  }
  track("gmail.sync_completed", ownerTrackId(owner), {
    scanned_messages: summary.scannedMessages,
    imported_cards: summary.imported,
    duplicate_cards: summary.duplicates,
    expired_cards: summary.expired,
    unparsed_messages: summary.unparsed,
  });

  return summary;
}

module.exports = {
  beginGmailConnect,
  beginGmailConnectForWeb,
  completeGmailSyncForOwner,
  disconnectGmailForOwner,
  getGmailStatusForUserUuid,
  handleGmailOAuthCallback,
  isGmailSyncConfigured,
  runGmailSync,
  runGmailSyncForOwner,
  _internals: {
    addLookbackToQuery,
    buildMessageCandidateText,
    collectCandidateMessageIds,
    decodeBase64Url,
    decodeHtmlEntities,
    hasGiftCardIntent,
    isExpired,
    markMessagesProcessed,
    parseGenericVoucherEmail,
    parseGiftCardFromEmailText,
    shouldExcludeEmailText,
    stripHtml,
    validateEmailParsedCard,
  },
};
