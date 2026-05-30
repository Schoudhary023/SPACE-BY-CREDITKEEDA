require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const cryptoNative = require("crypto");
const bcrypt = require("bcryptjs");
const { requireSupabaseUser } = require("./auth");
const {
  VAULT_SESSION_COOKIE,
  createWebVaultSession,
  deleteAllWebVaultSessionsForUserUuid,
  deleteWebVaultSession,
  getVaultSessionToken,
  getWebVaultSession,
} = require("./webVaultSessions");
const { extractGiftCardFromText, extractGiftCardsFromImage, isAiParsingEnabled } = require("../lib/aiParser");
const { parseCardInput, sanitizeParsedCard } = require("../lib/cardParser");
const {
  beginGmailConnectForWeb,
  completeGmailSyncForOwner,
  disconnectGmailForOwner,
  getGmailStatusForUserUuid,
  handleGmailOAuthCallback,
  runGmailSyncForOwner,
} = require("../lib/vaultGmail");
const { logError, logInfo } = require("../lib/logger");
const { supabase, withSupabaseRetry } = require("../lib/supabase");
const {
  changePinForUserUuid,
  deleteAccountDataByUserUuid,
  deleteSingleCardDataForUserUuid,
  decryptCardSecrets,
  fetchCardByIdForUserUuid,
  fetchCardsByUserUuid,
  findDuplicateEncryptedCardByUserUuid,
  isValidFingerprint,
  markCardRedeemedForUserUuid,
  recryptClientCardForUserUuid,
  resetVaultDataForUserUuid,
  saveEncryptedCardForUserUuid,
  updateEncryptedCardForUserUuid,
} = require("../lib/vaultCards");
const { getVaultAuthByUserUuid, verifyVaultPin } = require("../lib/vaultSessions");
const { verifyLinkToken, getLinkTokenRecord, consumeLinkToken } = require("../lib/vaultLink");
const { createMergeToken, mergeVaultsWithPins } = require("../lib/vaultMerge");
const {
  backfillLinkedTelegramData,
  createWebUser,
  forgetUserByAuthUserId,
  getUserByAuthUserOrEmail,
  getUserByUserUuid,
  resolveTelegramToWebLink,
} = require("../lib/vaultUsers");
const {
  addSecurityHeaders,
  getClientIp,
  isWebUserBlocked,
  checkUserRateLimit,
  checkIpRateLimit,
  checkLocalIpRateLimit,
  limits: GUARD_LIMITS,
  ipLimits: GUARD_IP_LIMITS,
  localIpLimits: GUARD_LOCAL_IP_LIMITS,
} = require("../lib/webGuards");
const {
  emailConfigured,
  startWebExpiryReminderJob,
  webPushConfigured,
} = require("../lib/webExpiryReminder");
const { FEATURES, isFeatureEnabledForUser } = require("../lib/featureFlags");

const API_PORT = Number(process.env.API_PORT || process.env.PORT || 3000);
const API_BIND_ADDRESS = process.env.API_BIND_ADDRESS || "0.0.0.0";
const API_VERSION = process.env.npm_package_version || "1.0.0";
// Set API_ALLOWED_ORIGINS env var to your frontend domain(s), comma-separated.
// e.g. API_ALLOWED_ORIGINS=https://your-space-domain.com,http://localhost:3000
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3100",
  "http://localhost:5173",
];
const API_ALLOWED_ORIGINS = String(process.env.API_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const DEV_UI_ENABLED = String(process.env.DEV_UI_ENABLED || "").toLowerCase() === "true";
const DEV_UI_HTML_PATH = path.join(__dirname, "testUi.html");
// Matches the Telegram bot's vault PIN rule (6 to 20 digits). Existing users created PINs
// under this rule, so the web app must accept the full range or they cannot unlock.
const WEB_VAULT_PIN_PATTERN = /^\d{6,20}$/;

// Server-side pepper for web client key derivation. Without this, a DB-only
// leak lets an attacker brute force 6-digit PINs against client-v1 ciphertext
// in seconds. With it, an attacker also needs the env secret to even start.
//
// Refuse to start if the secret is missing — silently falling back to the
// unpeppered legacy salt would silently downgrade security for new writes.
const ENCRYPTION_SECRET_WEB = process.env.ENCRYPTION_SECRET_WEB;
if (!ENCRYPTION_SECRET_WEB || ENCRYPTION_SECRET_WEB.length < 32) {
  throw new Error("ENCRYPTION_SECRET_WEB must be set to a value at least 32 chars long");
}

function deriveWebKeySalt(userUuid) {
  return cryptoNative
    .createHmac("sha256", ENCRYPTION_SECRET_WEB)
    .update(String(userUuid))
    .digest("hex");
}
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const STATUS_RATE_LIMIT_PATHS = new Set([
  "/api/gmail/status",
  "/api/notifications/status",
  "/api/vault/status",
]);
const EXPENSIVE_RATE_LIMIT_PATHS = new Set([
  "/api/gmail/connect",
  "/api/gmail/sync",
  "/api/gmail/sync/complete",
  "/api/cards/parse-image",
  "/api/cards/parse-text",
]);
const API_RATE_LIMITS_DISABLED = String(process.env.API_DISABLE_RATE_LIMITS || "").toLowerCase() === "true";
let webExpiryReminderJob = null;

function isLocalHost(req) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function buildVaultSessionCookie(req, token, expiresAt) {
  const sameSite = isLocalHost(req) ? "Lax" : "None";
  const parts = [
    `${VAULT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];

  if (!isLocalHost(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function buildClearVaultSessionCookie(req) {
  const sameSite = isLocalHost(req) ? "Lax" : "None";
  const parts = [
    `${VAULT_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0",
  ];

  if (!isLocalHost(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;

  if (!origin) {
    return null;
  }

  if (API_ALLOWED_ORIGINS.includes("*") || API_ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }

  return null;
}

function applyCors(req, res) {
  const allowedOrigin = getAllowedOrigin(req);

  if (!allowedOrigin) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-vault-session-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Vary", "Origin");
  return true;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res) {
  sendJson(res, 404, {
    ok: false,
    error: "Not found",
  });
}

function methodNotAllowed(res) {
  sendJson(res, 405, {
    ok: false,
    error: "Method not allowed",
  });
}

function unauthorized(res, message = "Unauthorized", extra = {}) {
  sendJson(res, 401, {
    ok: false,
    error: message,
    ...extra,
  });
}

function badRequest(res, message = "Bad request") {
  sendJson(res, 400, {
    ok: false,
    error: message,
  });
}

function conflict(res, message = "Conflict") {
  sendJson(res, 409, {
    ok: false,
    error: message,
  });
}

function forbidden(res, message = "Forbidden") {
  sendJson(res, 403, {
    ok: false,
    error: message,
  });
}

function tooManyRequests(res, retryAfter = 0, message = "Too many requests") {
  if (retryAfter > 0) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfter)));
  }
  sendJson(res, 429, {
    ok: false,
    error: message,
    retryAfter: retryAfter || undefined,
  });
}

async function enforceUserLimit(res, userUuid, bucket) {
  if (API_RATE_LIMITS_DISABLED) return true;
  const config = GUARD_LIMITS[bucket];
  if (!config) return true;
  const result = await checkUserRateLimit(userUuid, bucket, config.limit, config.windowMs);
  if (!result.allowed) {
    tooManyRequests(res, result.retryAfter);
    return false;
  }
  return true;
}

async function enforceIpLimit(res, ip, bucket) {
  if (API_RATE_LIMITS_DISABLED) return true;
  const config = GUARD_IP_LIMITS[bucket];
  if (!config) return true;
  const result = await checkIpRateLimit(ip, bucket, config.limit, config.windowMs);
  if (!result.allowed) {
    tooManyRequests(res, result.retryAfter);
    return false;
  }
  return true;
}

function enforceLocalIpLimit(res, ip, bucket) {
  if (API_RATE_LIMITS_DISABLED) return true;
  const config = GUARD_LOCAL_IP_LIMITS[bucket];
  if (!config) return true;
  const result = checkLocalIpRateLimit(ip, bucket, config.limit, config.windowMs);
  if (!result.allowed) {
    tooManyRequests(res, result.retryAfter);
    return false;
  }
  return true;
}

function redirectToSpaceApp(req, res, requestUrl) {
  const appUrl = String(process.env.SPACE_APP_URL || "").trim().replace(/\/+$/, "");
  if (!appUrl) {
    return false;
  }

  const hostUrl = `http://${req.headers.host || ""}`;
  let currentOrigin;
  try {
    currentOrigin = new URL(hostUrl).origin;
  } catch {
    currentOrigin = "";
  }

  if (currentOrigin && currentOrigin === new URL(appUrl).origin) {
    return false;
  }

  const target = `${appUrl}${requestUrl.pathname}${requestUrl.search || ""}`;
  res.writeHead(302, {
    Location: target,
    "Cache-Control": "no-store",
  });
  res.end();
  return true;
}

function locked(res, message, extra = {}) {
  sendJson(res, 423, {
    ok: false,
    error: message,
    ...extra,
  });
}

async function getAuthenticatedVaultContext(req, res) {
  const auth = await requireSupabaseUser(req);
  if (!auth.ok) {
    unauthorized(res, auth.error);
    return null;
  }

  const vaultUser = await getUserByAuthUserOrEmail(auth.user);

  if (vaultUser?.user_uuid) {
    if (vaultUser.telegram_id) {
      await backfillLinkedTelegramData(vaultUser.user_uuid);
    }
    if (await isWebUserBlocked(vaultUser.user_uuid)) {
      forbidden(res, "Account is blocked");
      return null;
    }
    if (!(await enforceUserLimit(res, vaultUser.user_uuid, "general"))) {
      return null;
    }
  }

  return {
    authUser: auth.user,
    vaultUser,
  };
}

async function getUnlockedVaultContext(req, res) {
  const context = await getAuthenticatedVaultContext(req, res);
  if (!context) {
    return null;
  }

  if (!context.vaultUser) {
    conflict(res, "No vault is linked to this web account");
    return null;
  }

  const session = getWebVaultSession(getVaultSessionToken(req), {
    authUserId: context.authUser.id,
    userUuid: context.vaultUser.user_uuid,
  });

  if (!session) {
    forbidden(res, "Vault is locked");
    return null;
  }

  return {
    ...context,
    session,
  };
}

function parseBooleanQuery(value) {
  return ["1", "true", "yes"].includes(String(value || "").toLowerCase());
}

function sanitizeUrlForLog(rawUrl) {
  try {
    const safeUrl = new URL(rawUrl || "/", "http://localhost");
    for (const key of ["access_token", "code", "merge", "refresh_token", "state", "token"]) {
      safeUrl.searchParams.delete(key);
    }
    return `${safeUrl.pathname}${safeUrl.search || ""}`;
  } catch {
    return "/";
  }
}

function serializeCard(card, decryptedCode, decryptedPin) {
  return {
    id: card.id,
    brand: card.brand,
    amount: card.amount,
    code: decryptedCode ?? card.code_encrypted,
    pin: decryptedPin ?? card.pin_encrypted ?? null,
    codeEncrypted: card.code_encrypted,
    pinEncrypted: card.pin_encrypted || null,
    cryptoMode: card.crypto_mode || "server",
    cryptoVersion: card.crypto_version || 1,
    expiryDate: card.expiry_date || null,
    isRedeemed: Boolean(card.is_redeemed),
    redeemedAt: card.redeemed_at || null,
    createdAt: card.created_at,
    source: card.source || "manual",
  };
}

function sendTelegramLinkSuccess(res, status, updatedVault) {
  sendJson(res, 200, {
    ok: true,
    status,
    vaultUser: {
      userUuid: updatedVault.user_uuid,
      email: updatedVault.email || null,
      telegramLinked: Boolean(updatedVault.telegram_id),
      webLinkedAt: updatedVault.web_linked_at || null,
    },
  });
}

function parseCardIdPath(pathname, suffix = "") {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^/api/cards/(\\d+)${escapedSuffix}$`);
  const match = pathname.match(pattern);
  return match ? Number(match[1]) : null;
}

function normalizePushSubscription(raw) {
  const endpoint = String(raw?.endpoint || "").trim();
  const p256dh = String(raw?.keys?.p256dh || "").trim();
  const auth = String(raw?.keys?.auth || "").trim();

  if (!endpoint || !p256dh || !auth) {
    return null;
  }

  return { endpoint, p256dh, auth };
}

function parseEncryptedCardPayload(body) {
  const brand = String(body.brand || "").trim();
  const amount = Number(body.amount);
  const codeEncrypted = String(body.codeEncrypted || "").trim();
  const pinEncrypted = body.pinEncrypted ? String(body.pinEncrypted).trim() : null;
  const codeFingerprint = String(body.codeFingerprint || "").trim();
  const codeFingerprintV2 = String(body.codeFingerprintV2 || "").trim();
  const expiryDate = body.expiryDate || null;

  // Reject client-v1 ciphertext on all new writes. After P0.1, the only
  // legitimate path that ever produces v1 is the dedicated `/recrypt`
  // endpoint reading old rows — and that endpoint refuses v1 too. Allowing
  // v1 here would let a stale or compromised client silently downgrade
  // protection back to the unpeppered KDF.
  if (codeEncrypted.startsWith("client-v1:") || (pinEncrypted && pinEncrypted.startsWith("client-v1:"))) {
    return null;
  }

  // Accept either fingerprint format on writes. New clients send v2; old or
  // partially-migrated clients still send v1. At least one is required so
  // duplicate detection never silently degrades to no-check.
  if (!brand || !Number.isFinite(amount) || amount < 0 || !codeEncrypted || (!codeFingerprint && !codeFingerprintV2)) {
    return null;
  }
  if ((codeFingerprint && !isValidFingerprint(codeFingerprint))
    || (codeFingerprintV2 && !isValidFingerprint(codeFingerprintV2))) {
    return null;
  }

  return {
    brand,
    amount,
    codeEncrypted,
    pinEncrypted,
    codeFingerprint: codeFingerprint || null,
    codeFingerprintV2: codeFingerprintV2 || null,
    expiryDate,
  };
}

function isValidWebVaultPin(value) {
  return WEB_VAULT_PIN_PATTERN.test(String(value || ""));
}

function isVertexFallbackError(error) {
  return [
    "VERTEX_UNAVAILABLE",
    "VERTEX_AUTH_ERROR",
    "VERTEX_BILLING_DISABLED",
    "VERTEX_MODEL_NOT_FOUND",
    "VERTEX_API_ERROR",
    "VERTEX_INVALID_RESPONSE",
  ].includes(error?.code);
}

async function parseCardPayload(body) {
  if (body.text) {
    const text = String(body.text || "");
    const localCard = parseCardInput(text);
    if (localCard) {
      return { card: localCard, mode: "local" };
    }

    if (!isAiParsingEnabled()) {
      return null;
    }

    const rawCard = await extractGiftCardFromText(text);
    const aiCard = sanitizeParsedCard(rawCard, { minConfidence: 0.6 });
    return aiCard ? { card: aiCard, mode: "vertex" } : null;
  }

  const card = sanitizeParsedCard(
    {
      brand: body.brand,
      amount: body.amount,
      code: body.code,
      pin: body.pin ?? null,
      expiryDate: body.expiryDate ?? null,
      confidence: 1,
    },
    { minConfidence: 1 }
  );

  return card ? { card, mode: "fields" } : null;
}

function getBase64ByteLength(value) {
  const normalized = String(value || "").replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (!normalized) {
    return 0;
  }

  const padding = (normalized.match(/=+$/) || [""])[0].length;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function normalizeImageBase64(value) {
  return String(value || "").replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
}

function parseJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    let receivedBytes = 0;

    req.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

async function handleRequest(req, res) {
  const hasCors = applyCors(req, res);
  addSecurityHeaders(res);

  if (req.method === "OPTIONS") {
    if (!hasCors && req.headers.origin) {
      sendJson(res, 403, {
        ok: false,
        error: "Origin not allowed",
      });
      return;
    }

    res.writeHead(204);
    res.end();
    return;
  }

  if (req.headers.origin && !hasCors) {
    sendJson(res, 403, {
      ok: false,
      error: "Origin not allowed",
    });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const clientIp = getClientIp(req);

  if (requestUrl.pathname !== "/health" && requestUrl.pathname !== "/ready") {
    if (!enforceLocalIpLimit(res, clientIp, "apiBurst")) {
      return;
    }

    if (STATUS_RATE_LIMIT_PATHS.has(requestUrl.pathname) && !enforceLocalIpLimit(res, clientIp, "statusBurst")) {
      return;
    }

    if (EXPENSIVE_RATE_LIMIT_PATHS.has(requestUrl.pathname) && !enforceLocalIpLimit(res, clientIp, "expensiveBurst")) {
      return;
    }

    if (!(await enforceIpLimit(res, clientIp, "globalBurst"))) {
      return;
    }
  }

  if (requestUrl.pathname === "/health" || requestUrl.pathname === "/ready") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    sendJson(res, 200, {
      ok: true,
      service: "creditkeeda-space-api",
      version: API_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  if (requestUrl.pathname === "/api/version") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    sendJson(res, 200, {
      ok: true,
      service: "creditkeeda-space-api",
      version: API_VERSION,
    });
    return;
  }

  if (requestUrl.pathname === "/api/gmail/callback" || requestUrl.pathname === "/oauth/google/callback") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    await handleGmailOAuthCallback(null, req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/api/me") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    const auth = await requireSupabaseUser(req);
    if (!auth.ok) {
      unauthorized(res, auth.error);
      return;
    }

    const vaultUser = await getUserByAuthUserOrEmail(auth.user);
    sendJson(res, 200, {
      ok: true,
      vaultUser: vaultUser
        ? {
            userUuid: vaultUser.user_uuid,
            email: vaultUser.email || null,
            telegramLinked: Boolean(vaultUser.telegram_id),
            webLinkedAt: vaultUser.web_linked_at || null,
          }
        : null,
    });
    return;
  }

  if (requestUrl.pathname === "/api/vault/status") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    const session = context.vaultUser
      ? getWebVaultSession(getVaultSessionToken(req), {
          authUserId: context.authUser.id,
          userUuid: context.vaultUser.user_uuid,
        })
      : null;

    sendJson(res, 200, {
      ok: true,
      linked: Boolean(context.vaultUser),
      unlocked: Boolean(session),
      expiresAt: session ? session.expiresAt.toISOString() : null,
      // webKeySalt is returned only when the session is live, so a locked
      // browser session cannot fish it from a public endpoint. It is the input
      // to the v2 PBKDF2 derivation on the client.
      webKeySalt: session ? deriveWebKeySalt(context.vaultUser.user_uuid) : null,
    });
    return;
  }

  if (requestUrl.pathname === "/api/vault/unlock") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    if (!(await enforceIpLimit(res, clientIp, "unlockBurst"))) {
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!context.vaultUser) {
      conflict(res, "No vault is linked to this web account");
      return;
    }

    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, "unlock"))) {
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 16 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const pin = String(body.pin || "").trim();
    if (!isValidWebVaultPin(pin)) {
      badRequest(res, "Vault PIN must be 6 to 20 digits");
      return;
    }

    const vaultAuth = await getVaultAuthByUserUuid(context.vaultUser.user_uuid);
    const verification = await verifyVaultPin(vaultAuth, pin, {
      trackUserId: vaultAuth?.telegram_id || vaultAuth?.user_uuid || context.authUser.id,
    });

    if (verification.status === "locked") {
      locked(res, "Vault is temporarily locked", {
        retryAfterMinutes: verification.retryAfterMinutes,
      });
      return;
    }

    if (!verification.ok) {
      unauthorized(res, "Wrong PIN", {
        attemptsRemaining: verification.attemptsRemaining,
        lockoutMinutes: verification.lockoutMinutes,
      });
      return;
    }

    const session = createWebVaultSession({
      authUserId: context.authUser.id,
      userUuid: vaultAuth.user_uuid,
      encryptionSalt: verification.encryptionSalt,
    });

    res.setHeader("Set-Cookie", buildVaultSessionCookie(req, session.token, session.expiresAt));
    sendJson(res, 200, {
      ok: true,
      expiresAt: session.expiresAt,
      // encryptionSalt is the raw UUID needed to decrypt any remaining
      // client-v1 ciphertext; webKeySalt is the peppered v2 input. Clients
      // hold the v2 key in IndexedDB and only derive the v1 key on demand
      // when reading old rows.
      encryptionSalt: verification.encryptionSalt,
      webKeySalt: deriveWebKeySalt(vaultAuth.user_uuid),
    });
    return;
  }

  if (requestUrl.pathname === "/api/vault/create") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const auth = await requireSupabaseUser(req);
    if (!auth.ok) {
      unauthorized(res, auth.error);
      return;
    }

    const existingVaultUser = await getUserByAuthUserOrEmail(auth.user);
    if (existingVaultUser) {
      conflict(res, "This web account already has a vault");
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 16 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const pin = String(body.pin || "").trim();
    const confirmPin = String(body.confirmPin || "").trim();
    if (!isValidWebVaultPin(pin)) {
      badRequest(res, "Vault PIN must be 6 to 20 digits");
      return;
    }
    if (confirmPin !== pin) {
      badRequest(res, "Vault PINs do not match");
      return;
    }

    const vaultPinHash = await bcrypt.hash(pin, 12);
    const vaultUser = await createWebUser({
      authUserId: auth.user.id,
      email: auth.user.email || null,
      vaultPinHash,
    });

    sendJson(res, 201, {
      ok: true,
      vaultUser: {
        userUuid: vaultUser.user_uuid,
        email: vaultUser.email || null,
        telegramLinked: Boolean(vaultUser.telegram_id),
        webLinkedAt: vaultUser.web_linked_at || null,
      },
    });
    return;
  }

  if (requestUrl.pathname === "/api/vault/lock") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    const token = getVaultSessionToken(req);
    const session = context.vaultUser
      ? getWebVaultSession(token, {
          authUserId: context.authUser.id,
          userUuid: context.vaultUser.user_uuid,
        })
      : null;

    if (session) {
      deleteWebVaultSession(token);
    }

    res.setHeader("Set-Cookie", buildClearVaultSessionCookie(req));
    sendJson(res, 200, {
      ok: true,
      locked: true,
    });
    return;
  }

  if (requestUrl.pathname === "/api/account") {
    if (req.method !== "DELETE") {
      methodNotAllowed(res);
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    let body = {};
    try {
      body = await parseJsonBody(req, { maxBytes: 4 * 1024 });
    } catch {
      body = {};
    }

    if (String(body.confirm || "").trim() !== "DELETE") {
      badRequest(res, "Type DELETE to confirm account deletion");
      return;
    }

    const userUuid = context.vaultUser?.user_uuid || null;
    const authUserId = context.authUser?.id || null;
    const telegramId = context.vaultUser?.telegram_id || null;

    if (userUuid) {
      try {
        await deleteAccountDataByUserUuid(userUuid, { telegramId });
      } catch (error) {
        logError("Delete account: vault wipe failed", error, { userUuid });
        sendJson(res, 500, { ok: false, error: "Could not delete vault data" });
        return;
      }
      deleteAllWebVaultSessionsForUserUuid(userUuid);
    }

    if (authUserId) {
      try {
        const { error: adminError } = await supabase.auth.admin.deleteUser(authUserId);
        if (adminError) {
          logError("Delete account: supabase auth deletion failed", adminError, { authUserId });
        }
      } catch (error) {
        logError("Delete account: supabase auth deletion threw", error, { authUserId });
      }
    }

    logInfo("Account deleted", { userUuid, authUserId, telegramId });

    res.setHeader("Set-Cookie", buildClearVaultSessionCookie(req));
    sendJson(res, 200, { ok: true, deleted: true });
    return;
  }

  // DELETE /api/vault — wipe vault data, keep Supabase auth account + session
  if (requestUrl.pathname === "/api/vault" && req.method === "DELETE") {
    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) return;

    const userUuid = context.vaultUser?.user_uuid;
    if (!userUuid) {
      // Already gone — idempotent success so the client can proceed to "Create vault"
      forgetUserByAuthUserId(context.authUser.id);
      res.setHeader("Set-Cookie", buildClearVaultSessionCookie(req));
      sendJson(res, 200, { ok: true });
      return;
    }

    try {
      await resetVaultDataForUserUuid(userUuid, { authUserId: context.authUser.id, email: context.authUser.email });
    } catch (error) {
      logError("Reset vault: wipe failed", error, { userUuid });
      sendJson(res, 500, { ok: false, error: "Failed to reset vault" });
      return;
    }

    deleteAllWebVaultSessionsForUserUuid(userUuid);
    forgetUserByAuthUserId(context.authUser.id);
    res.setHeader("Set-Cookie", buildClearVaultSessionCookie(req));
    logInfo("Vault reset", { userUuid });
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/vault/change-pin — re-encrypt all cards and update PIN hash atomically
  if (requestUrl.pathname === "/api/vault/change-pin" && req.method === "POST") {
    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) return;

    const userUuid = context.vaultUser?.user_uuid;
    if (!userUuid) {
      sendJson(res, 404, { ok: false, error: "No vault found" });
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 4 * 1024 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const { oldPin, newPin, cards } = body;

    if (!oldPin || typeof oldPin !== "string") { badRequest(res, "oldPin required"); return; }
    if (!newPin || typeof newPin !== "string") { badRequest(res, "newPin required"); return; }
    if (newPin.length < 4) { badRequest(res, "New PIN must be at least 4 characters"); return; }
    if (!Array.isArray(cards)) { badRequest(res, "cards array required"); return; }

    // Verify old PIN
    const vaultAuth = await getVaultAuthByUserUuid(userUuid);
    if (!vaultAuth) {
      sendJson(res, 404, { ok: false, error: "Vault not found" });
      return;
    }

    const pinOk = await bcrypt.compare(String(oldPin), vaultAuth.vault_pin_hash);
    if (!pinOk) {
      sendJson(res, 401, { ok: false, error: "Current PIN is incorrect" });
      return;
    }

    // Validate card payloads
    for (const card of cards) {
      if (!card.id || typeof card.id !== "number") { badRequest(res, "Each card must have a numeric id"); return; }
      if (!card.codeEncrypted || !String(card.codeEncrypted).startsWith("client-v2:")) {
        badRequest(res, `Card ${card.id}: codeEncrypted must be client-v2 ciphertext`);
        return;
      }
    }

    const newPinHash = await bcrypt.hash(String(newPin), 12);

    try {
      await changePinForUserUuid(userUuid, newPinHash, cards);
    } catch (error) {
      logError("Change PIN: update failed", error, { userUuid, failedCardId: error.failedCardId });
      sendJson(res, 500, { ok: false, error: "PIN change failed. Your old PIN is still active. Please try again." });
      return;
    }

    deleteAllWebVaultSessionsForUserUuid(userUuid);
    res.setHeader("Set-Cookie", buildClearVaultSessionCookie(req));
    logInfo("Vault PIN changed", { userUuid, cardCount: cards.length });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === "/api/gmail/status") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!context.vaultUser) {
      conflict(res, "No vault is linked to this web account");
      return;
    }

    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, "gmailStatus"))) {
      return;
    }

    const enabled = await isFeatureEnabledForUser(context.vaultUser.user_uuid, FEATURES.GMAIL_SYNC);
    const status = await getGmailStatusForUserUuid(context.vaultUser.user_uuid);
    sendJson(res, 200, {
      ok: true,
      enabled,
      ...status,
    });
    return;
  }

  if (requestUrl.pathname === "/api/gmail/connect") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!context.vaultUser) {
      conflict(res, "No vault is linked to this web account");
      return;
    }

    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, "gmailConnect"))) {
      return;
    }

    if (!(await isFeatureEnabledForUser(context.vaultUser.user_uuid, FEATURES.GMAIL_SYNC))) {
      sendJson(res, 403, { ok: false, error: "Gmail sync is coming soon" });
      return;
    }

    try {
      const connection = await beginGmailConnectForWeb(context.vaultUser.user_uuid);
      sendJson(res, 200, {
        ok: true,
        ...connection,
      });
    } catch (error) {
      if (error.code === "GMAIL_NOT_CONFIGURED") {
        sendJson(res, 503, { ok: false, error: "Gmail sync is not configured" });
        return;
      }

      throw error;
    }
    return;
  }

  if (requestUrl.pathname === "/api/gmail/disconnect") {
    if (req.method !== "DELETE") {
      methodNotAllowed(res);
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!context.vaultUser) {
      conflict(res, "No vault is linked to this web account");
      return;
    }

    await disconnectGmailForOwner({
      userUuid: context.vaultUser.user_uuid,
      telegramId: context.vaultUser.telegram_id || null,
    });
    logInfo("Gmail disconnected from web vault", { userUuid: context.vaultUser.user_uuid });

    sendJson(res, 200, {
      ok: true,
      disconnected: true,
    });
    return;
  }

  if (requestUrl.pathname === "/api/gmail/sync") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, "gmailSync"))) {
      return;
    }

    if (!(await isFeatureEnabledForUser(context.vaultUser.user_uuid, FEATURES.GMAIL_SYNC))) {
      sendJson(res, 403, { ok: false, error: "Gmail sync is coming soon" });
      return;
    }

    try {
      const summary = await runGmailSyncForOwner(
        {
          userUuid: context.vaultUser.user_uuid,
          telegramId: context.vaultUser.telegram_id || null,
        },
        { save: false }
      );

      sendJson(res, 200, {
        ok: true,
        summary,
      });
    } catch (error) {
      if (error.code === "GMAIL_NOT_CONFIGURED") {
        sendJson(res, 503, { ok: false, error: "Gmail sync is not configured" });
        return;
      }

      if (error.code === "GMAIL_NOT_CONNECTED") {
        conflict(res, "Gmail is not connected");
        return;
      }

      throw error;
    }
    return;
  }

  if (requestUrl.pathname === "/api/gmail/sync/complete") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, "gmailComplete"))) {
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 64 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const messageIds = Array.isArray(body.messageIds) ? body.messageIds : [];
    const result = await completeGmailSyncForOwner(
      {
        userUuid: context.vaultUser.user_uuid,
        telegramId: context.vaultUser.telegram_id || null,
      },
      messageIds
    );

    sendJson(res, 200, {
      ok: true,
      ...result,
    });
    return;
  }

  if (requestUrl.pathname === "/api/cards") {
    if (req.method !== "GET" && req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    const cardsBucket = req.method === "POST" ? "save" : "cards";
    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, cardsBucket))) {
      return;
    }

    if (req.method === "GET") {
      const includeRedeemed = parseBooleanQuery(requestUrl.searchParams.get("includeRedeemed"));
      const searchTerm = String(requestUrl.searchParams.get("search") || "").trim() || null;

      if (searchTerm && searchTerm.length > 100) {
        badRequest(res, "Search term is too long");
        return;
      }

      const cards = await fetchCardsByUserUuid(context.vaultUser.user_uuid, {
        includeRedeemed,
        searchTerm,
      });

      sendJson(res, 200, {
        ok: true,
        cards: cards.map((card) => serializeCard(card)),
      });
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 64 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const parsed = parseEncryptedCardPayload(body);
    if (!parsed) {
      badRequest(res, "Encrypted card details are required");
      return;
    }

    const duplicate = await findDuplicateEncryptedCardByUserUuid(
      context.vaultUser.user_uuid,
      parsed.brand,
      { v1: parsed.codeFingerprint, v2: parsed.codeFingerprintV2 }
    );

    if (duplicate) {
      conflict(res, "This gift card is already saved");
      return;
    }

    const inserted = await saveEncryptedCardForUserUuid(
      context.vaultUser.user_uuid,
      parsed,
      body.source || "manual"
    );

    sendJson(res, 201, {
      ok: true,
      card: {
        id: inserted.id,
        brand: parsed.brand,
        amount: parsed.amount,
        expiryDate: parsed.expiryDate,
        isRedeemed: false,
      },
    });
    return;
  }

  if (requestUrl.pathname === "/api/notifications/status") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    let activePushSubscriptions = 0;
    if (context.vaultUser?.user_uuid) {
      const { count, error } = await withSupabaseRetry(() =>
        supabase
          .from("web_push_subscriptions_vault")
          .select("id", { count: "exact", head: true })
          .eq("user_uuid", context.vaultUser.user_uuid)
          .is("disabled_at", null)
      );
      if (error) throw error;
      activePushSubscriptions = count || 0;
    }

    sendJson(res, 200, {
      ok: true,
      emailConfigured: emailConfigured(),
      pushConfigured: webPushConfigured(),
      vapidPublicKey: process.env.WEB_PUSH_PUBLIC_KEY || null,
      activePushSubscriptions,
    });
    return;
  }

  if (requestUrl.pathname === "/api/notifications/push-subscription") {
    if (req.method !== "POST" && req.method !== "DELETE") {
      methodNotAllowed(res);
      return;
    }

    const context = await getAuthenticatedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!context.vaultUser?.user_uuid) {
      conflict(res, "No vault is linked to this web account");
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 32 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    if (req.method === "DELETE") {
      const endpoint = String(body.endpoint || "").trim();
      if (!endpoint) {
        badRequest(res, "endpoint is required");
        return;
      }

      const { error } = await withSupabaseRetry(() =>
        supabase
          .from("web_push_subscriptions_vault")
          .update({ disabled_at: new Date().toISOString() })
          .eq("user_uuid", context.vaultUser.user_uuid)
          .eq("endpoint", endpoint)
      );
      if (error) throw error;

      sendJson(res, 200, { ok: true });
      return;
    }

    const subscription = normalizePushSubscription(body.subscription || body);
    if (!subscription) {
      badRequest(res, "Invalid push subscription");
      return;
    }

    const { error } = await withSupabaseRetry(() =>
      supabase
        .from("web_push_subscriptions_vault")
        .upsert({
          user_uuid: context.vaultUser.user_uuid,
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          user_agent: String(req.headers["user-agent"] || "").slice(0, 500) || null,
          disabled_at: null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "endpoint" })
    );

    if (error) throw error;

    sendJson(res, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === "/api/cards/parse-image") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, "imageSave"))) {
      return;
    }

    if (!isAiParsingEnabled()) {
      badRequest(res, "AI image parsing is not enabled");
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: IMAGE_MAX_BYTES + 1024 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const imageBase64 = normalizeImageBase64(body.imageBase64);
    const mimeType = String(body.mimeType || "").toLowerCase();

    if (!imageBase64) {
      badRequest(res, "imageBase64 is required");
      return;
    }

    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      badRequest(res, "Unsupported image type");
      return;
    }

    if (getBase64ByteLength(imageBase64) > IMAGE_MAX_BYTES) {
      badRequest(res, "Image is too large");
      return;
    }

    const rawCards = await extractGiftCardsFromImage({
      imageBase64,
      mimeType,
      caption: body.caption || "",
    });
    const parsedCards = rawCards.map((card) => sanitizeParsedCard(card, { requireAmount: false })).filter(Boolean);

    sendJson(res, 200, {
      ok: true,
      cards: parsedCards,
    });
    return;
  }

  if (requestUrl.pathname === "/api/cards/parse-text") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, "aiText"))) {
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 64 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    let parseResult;
    try {
      parseResult = await parseCardPayload({ text: body.text });
    } catch (error) {
      if (isVertexFallbackError(error)) {
        sendJson(res, 503, { ok: false, error: "AI parsing is temporarily unavailable. Try again or enter Brand Amount Code manually." });
        return;
      }
      throw error;
    }

    if (!parseResult?.card) {
      badRequest(res, "Invalid card details");
      return;
    }

    sendJson(res, 200, {
      ok: true,
      card: parseResult.card,
      mode: parseResult.mode,
    });
    return;
  }

  if (requestUrl.pathname === "/api/cards/legacy-export") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    if (!(await enforceUserLimit(res, context.vaultUser.user_uuid, "legacyExport"))) {
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 16 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const pin = String(body.pin || "").trim();
    if (!pin) {
      badRequest(res, "PIN is required");
      return;
    }

    const vaultAuth = await getVaultAuthByUserUuid(context.vaultUser.user_uuid);
    const verification = await verifyVaultPin(vaultAuth, pin, {
      trackUserId: vaultAuth?.telegram_id || vaultAuth?.user_uuid || context.authUser.id,
    });

    if (verification.status === "locked") {
      locked(res, "Vault is temporarily locked", {
        retryAfterMinutes: verification.retryAfterMinutes,
      });
      return;
    }

    if (!verification.ok) {
      unauthorized(res, "Wrong PIN", {
        attemptsRemaining: verification.attemptsRemaining,
        lockoutMinutes: verification.lockoutMinutes,
      });
      return;
    }

    const cards = await fetchCardsByUserUuid(context.vaultUser.user_uuid, { includeRedeemed: true });
    const legacyCards = cards.filter((card) => (card.crypto_mode || "server") === "server");
    const exportedCards = [];

    logInfo("Legacy card export requested", {
      userUuid: context.vaultUser.user_uuid,
      legacyCardCount: legacyCards.length,
    });

    for (const card of legacyCards) {
      const { decryptedCode, decryptedPin } = await decryptCardSecrets(card, pin, verification.encryptionSalt);
      exportedCards.push({
        id: card.id,
        brand: card.brand,
        amount: card.amount,
        code: decryptedCode,
        pin: decryptedPin,
        expiryDate: card.expiry_date || null,
      });
    }

    sendJson(res, 200, {
      ok: true,
      cards: exportedCards,
    });
    return;
  }

  // In-place ciphertext re-encrypt: used by the v1 -> v2 web crypto upgrade.
  // The row stays crypto_mode='client' but the ciphertext switches from
  // client-v1 (PBKDF2 250k, unpeppered) to client-v2 (PBKDF2 600k, peppered).
  const recryptCardId = parseCardIdPath(requestUrl.pathname, "/recrypt");
  if (recryptCardId) {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) return;

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 32 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const codeEncrypted = String(body.codeEncrypted || "").trim();
    const pinEncrypted = body.pinEncrypted ? String(body.pinEncrypted).trim() : null;
    const codeFingerprintV2 = body.codeFingerprintV2 ? String(body.codeFingerprintV2).trim() : "";

    if (!codeEncrypted.startsWith("client-v2:")) {
      badRequest(res, "Recrypt requires client-v2 ciphertext");
      return;
    }
    if (pinEncrypted && !pinEncrypted.startsWith("client-v2:")) {
      badRequest(res, "Recrypt requires client-v2 ciphertext");
      return;
    }
    // Required so the upgraded row also gets the new salted fingerprint —
    // otherwise duplicate detection regresses to the unsalted v1 hash.
    if (!codeFingerprintV2) {
      badRequest(res, "codeFingerprintV2 is required");
      return;
    }
    if (!isValidFingerprint(codeFingerprintV2)) {
      badRequest(res, "codeFingerprintV2 is invalid");
      return;
    }

    const updated = await recryptClientCardForUserUuid(recryptCardId, context.vaultUser.user_uuid, {
      codeEncrypted,
      pinEncrypted,
      codeFingerprintV2,
    });
    if (!updated) {
      notFound(res);
      return;
    }

    sendJson(res, 200, { ok: true, recrypted: true });
    return;
  }

  const redeemCardId = parseCardIdPath(requestUrl.pathname, "/redeem");
  if (redeemCardId) {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    const card = await markCardRedeemedForUserUuid(redeemCardId, context.vaultUser.user_uuid);
    if (!card) {
      notFound(res);
      return;
    }

    sendJson(res, 200, {
      ok: true,
      card: serializeCard(card),
    });
    return;
  }

  const cardId = parseCardIdPath(requestUrl.pathname);
  if (cardId) {
    if (req.method !== "DELETE" && req.method !== "PATCH") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    const card = await fetchCardByIdForUserUuid(cardId, context.vaultUser.user_uuid);
    if (!card) {
      notFound(res);
      return;
    }

    if (req.method === "PATCH") {
      let body;
      try {
        body = await parseJsonBody(req, { maxBytes: 32 * 1024 });
      } catch (error) {
        badRequest(res, error.message);
        return;
      }

      const encrypted = parseEncryptedCardPayload({
        brand: card.brand,
        amount: card.amount,
        codeEncrypted: body.codeEncrypted,
        pinEncrypted: body.pinEncrypted || null,
        codeFingerprint: body.codeFingerprint,
        codeFingerprintV2: body.codeFingerprintV2,
        expiryDate: card.expiry_date || null,
      });

      if (!encrypted) {
        badRequest(res, "Encrypted card details are required");
        return;
      }

      const updated = await updateEncryptedCardForUserUuid(cardId, context.vaultUser.user_uuid, encrypted);
      if (!updated) {
        conflict(res, "Card is not eligible for upgrade");
        return;
      }

      sendJson(res, 200, {
        ok: true,
        upgraded: true,
        cardId,
      });
      return;
    }

    await deleteSingleCardDataForUserUuid(cardId, context.vaultUser.user_uuid);

    sendJson(res, 200, {
      ok: true,
      deleted: true,
      cardId,
    });
    return;
  }

  // POST /api/link/telegram/confirm — web user lands on /link?token=xxx after bot deeplink
  if (requestUrl.pathname === "/api/link/telegram/confirm") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const auth = await requireSupabaseUser(req);
    if (!auth.ok) {
      unauthorized(res, auth.error);
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 16 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const token = String(body.token || "").trim();
    if (!token) {
      badRequest(res, "token is required");
      return;
    }

    const tokenRecord = await getLinkTokenRecord(token, "telegram_to_web");
    if (tokenRecord?.user_uuid) {
      const [targetVault, currentVault] = await Promise.all([
        getUserByUserUuid(tokenRecord.user_uuid),
        getUserByAuthUserOrEmail(auth.user),
      ]);
      const alreadyLinkedToThisUser =
        targetVault?.auth_user_id &&
        String(targetVault.auth_user_id) === String(auth.user.id) &&
        currentVault?.user_uuid === targetVault.user_uuid &&
        Boolean(targetVault.telegram_id);

      if (alreadyLinkedToThisUser) {
        sendTelegramLinkSuccess(res, "already_linked", targetVault);
        return;
      }
    }

    const verified = await verifyLinkToken(token, "telegram_to_web");
    if (!verified.ok) {
      const messages = {
        not_found: "Invalid link token",
        expired: "This link has expired. Please generate a new one from the Telegram bot.",
        already_used: "This link has already been used.",
      };
      badRequest(res, messages[verified.reason] || "Invalid token");
      return;
    }

    const linkResult = await resolveTelegramToWebLink(verified.userUuid, { authUser: auth.user });
    if (linkResult.status === "not_found") {
      badRequest(res, "Invalid link token");
      return;
    }

    if (linkResult.status === "merge_required") {
      const mergeToken = createMergeToken({
        primaryUserUuid: linkResult.primaryUserUuid,
        secondaryUserUuid: linkResult.secondaryUserUuid,
        reason: "telegram_to_web",
      });
      sendJson(res, 409, {
        ok: false,
        error: "Both accounts already have saved vault data. Merge requires both vault PINs.",
        mergeRequired: true,
        mergeToken,
        primaryCardCount: linkResult.primaryCardCount,
        secondaryCardCount: linkResult.secondaryCardCount,
      });
      return;
    }

    const successfulStatuses = new Set([
      "linked",
      "already_linked",
      "linked_removed_empty_web",
      "linked_existing_web",
    ]);
    if (!successfulStatuses.has(linkResult.status)) {
      conflict(res, "This link could not be completed. Generate a fresh link and try again.");
      return;
    }

    await consumeLinkToken(token);

    const updatedVault = await getUserByUserUuid(linkResult.userUuid);

    sendTelegramLinkSuccess(res, linkResult.status, updatedVault);
    return;
  }

  if (requestUrl.pathname === "/api/vault/merge") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const context = await getUnlockedVaultContext(req, res);
    if (!context) {
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req, { maxBytes: 32 * 1024 });
    } catch (error) {
      badRequest(res, error.message);
      return;
    }

    const telegramPin = String(body.telegramPin || body.secondaryPin || "").trim();
    const webPin = String(body.webPin || body.primaryPin || "").trim();
    if (!webPin) {
      badRequest(res, "Space vault PIN is required");
      return;
    }

    if (!telegramPin) {
      badRequest(res, "Telegram vault PIN is required");
      return;
    }

    try {
      const result = await mergeVaultsWithPins({
        mergeToken: String(body.mergeToken || "").trim(),
        primaryPin: webPin,
        secondaryPin: telegramPin,
        finalPin: String(body.finalPin || "").trim(),
        authUserId: context.authUser.id,
      });
      const updatedVault = await getUserByUserUuid(result.userUuid);
      deleteAllWebVaultSessionsForUserUuid(result.userUuid);

      res.setHeader("Set-Cookie", buildClearVaultSessionCookie(req));
      sendJson(res, 200, {
        ok: true,
        merged: true,
        ...result,
        vaultUser: {
          userUuid: updatedVault.user_uuid,
          email: updatedVault.email || null,
          telegramLinked: Boolean(updatedVault.telegram_id),
          webLinkedAt: updatedVault.web_linked_at || null,
        },
      });
    } catch (error) {
      if (error.code === "MERGE_BAD_PIN") {
        unauthorized(res, error.message);
        return;
      }

      if (error.code === "MERGE_FINAL_PIN_REQUIRED" || error.code === "MERGE_CLIENT_CARDS_PRESENT") {
        conflict(res, error.message);
        return;
      }

      if (error.code === "MERGE_BAD_FINAL_PIN" || error.code === "MERGE_TOKEN_INVALID" || error.code === "MERGE_VAULT_NOT_FOUND") {
        badRequest(res, error.message);
        return;
      }

      if (error.code === "MERGE_FORBIDDEN") {
        forbidden(res, error.message);
        return;
      }

      throw error;
    }
    return;
  }

  if (
    requestUrl.pathname === "/merge" ||
    requestUrl.pathname === "/merge/" ||
    requestUrl.pathname === "/link" ||
    requestUrl.pathname === "/link/"
  ) {
    if (redirectToSpaceApp(req, res, requestUrl)) {
      return;
    }
  }

  if (
    requestUrl.pathname === "/" ||
    requestUrl.pathname === "/ui" ||
    requestUrl.pathname === "/ui/" ||
    requestUrl.pathname === "/link" ||
    requestUrl.pathname === "/link/"
  ) {
    if (!DEV_UI_ENABLED) {
      notFound(res);
      return;
    }

    if (req.method !== "GET") {
      methodNotAllowed(res);
      return;
    }

    let html;
    try {
      html = fs.readFileSync(DEV_UI_HTML_PATH, "utf8");
    } catch {
      sendJson(res, 500, { ok: false, error: "Dev UI file not found" });
      return;
    }

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
    html = html
      .replace("__SUPABASE_URL__", supabaseUrl)
      .replace("__SUPABASE_ANON_KEY__", supabaseAnonKey);

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
    });
    res.end(html);
    return;
  }

  notFound(res);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    logError("API request failed", error, {
      method: req.method,
      url: sanitizeUrlForLog(req.url),
    });
    sendJson(res, 500, {
      ok: false,
      error: "Internal server error",
    });
  });
});

server.listen(API_PORT, API_BIND_ADDRESS, () => {
  logInfo("CreditKeeda Space API is running", {
    port: API_PORT,
    bindAddress: API_BIND_ADDRESS,
    host: os.hostname(),
    nodeVersion: process.version,
  });

  try {
    webExpiryReminderJob = startWebExpiryReminderJob();
  } catch (error) {
    logError("Failed to start web expiry reminder job", error);
  }
});

function shutdown(signal) {
  logInfo("API shutdown requested", { signal });
  if (webExpiryReminderJob) {
    try {
      webExpiryReminderJob.stop();
    } catch (error) {
      logError("Failed to stop web expiry reminder job", error, { signal });
    }
  }
  server.close((error) => {
    if (error) {
      logError("API shutdown failed", error, { signal });
      process.exit(1);
    }

    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logError("Unhandled API promise rejection", reason instanceof Error ? reason : new Error(String(reason)));
});

process.on("uncaughtException", (error) => {
  logError("Uncaught API exception", error);
  process.exit(1);
});

module.exports = {
  parseJsonBody,
};
