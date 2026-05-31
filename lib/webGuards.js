const { supabase, withSupabaseRetry } = require("./supabase");
const { checkRateLimit } = require("./runtimeStore");
const { logError } = require("./logger");

const IMAGE_SAVE_DAILY_LIMIT = process.env.IMAGE_SAVE_DAILY_LIMIT
  ? Number(process.env.IMAGE_SAVE_DAILY_LIMIT)
  : 5;
const AI_TEXT_DAILY_LIMIT = process.env.AI_TEXT_DAILY_LIMIT
  ? Number(process.env.AI_TEXT_DAILY_LIMIT)
  : 20;
const GMAIL_SYNC_HOURLY_LIMIT = process.env.GMAIL_SYNC_HOURLY_LIMIT
  ? Number(process.env.GMAIL_SYNC_HOURLY_LIMIT)
  : 3;

const localRateBuckets = new Map();

function checkLocalRateLimit(bucketKey, limit, windowMs) {
  const now = Date.now();
  const windowStartedAt = now - (now % windowMs);
  const existing = localRateBuckets.get(bucketKey);
  const entry = existing && existing.windowStartedAt === windowStartedAt
    ? existing
    : { count: 0, windowStartedAt };

  entry.count += 1;
  localRateBuckets.set(bucketKey, entry);

  if (localRateBuckets.size > 5000) {
    for (const [key, value] of localRateBuckets) {
      if (value.windowStartedAt < windowStartedAt - windowMs) {
        localRateBuckets.delete(key);
      }
    }
  }

  return {
    allowed: entry.count <= limit,
    retryAfter: Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1000)),
  };
}

function addSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Content-Security-Policy", "object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

// Number of trusted reverse proxies in front of the API.
// Set TRUSTED_PROXY_HOPS to the number of proxy hops (e.g. 1 if behind a single
// reverse proxy). When set, the client IP is read that many hops from the RIGHT
// of X-Forwarded-For — the only entries a client cannot spoof. Left unset, we
// fall back to the socket remote address so local/dev setups are unaffected.
const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS) || 0);

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (TRUSTED_PROXY_HOPS > 0 && forwarded.length) {
    const index = Math.max(0, forwarded.length - TRUSTED_PROXY_HOPS);
    if (forwarded[index]) return forwarded[index];
  }

  if (TRUSTED_PROXY_HOPS > 0) {
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
  }
  return String(req.socket?.remoteAddress || "unknown");
}

async function isWebUserBlocked(userUuid) {
  if (!userUuid) return false;
  try {
    const { data, error } = await withSupabaseRetry(() =>
      supabase
        .from("users_vault")
        .select("id, blocked_users_vault!inner(unblocked_at)")
        .eq("user_uuid", userUuid)
        .is("blocked_users_vault.unblocked_at", null)
        .maybeSingle()
    );
    if (error && error.code !== "PGRST116") {
      logError("webGuards.isWebUserBlocked", error, { userUuid });
      return false;
    }
    return Boolean(data);
  } catch (error) {
    logError("webGuards.isWebUserBlocked.catch", error, { userUuid });
    return false;
  }
}

async function checkUserRateLimit(userUuid, bucket, limit, windowMs) {
  if (!userUuid) return { allowed: true, retryAfter: 0 };
  try {
    return await checkRateLimit(`web:${bucket}:${userUuid}`, limit, windowMs);
  } catch (error) {
    logError("webGuards.checkUserRateLimit", error, { userUuid, bucket });
    if (bucket === "unlock" || bucket === "pinChange") {
      return { allowed: false, retryAfter: 60 };
    }
    return checkLocalRateLimit(`web-fallback:${bucket}:${userUuid}`, limit, windowMs);
  }
}

async function checkIpRateLimit(ip, bucket, limit, windowMs) {
  if (!ip) return { allowed: true, retryAfter: 0 };
  try {
    return await checkRateLimit(`web-ip:${bucket}:${ip}`, limit, windowMs);
  } catch (error) {
    logError("webGuards.checkIpRateLimit", error, { ip, bucket });
    if (bucket === "unlockBurst" || bucket === "authBurst") {
      return { allowed: false, retryAfter: 60 };
    }
    return checkLocalRateLimit(`web-ip-fallback:${bucket}:${ip}`, limit, windowMs);
  }
}

function checkLocalIpRateLimit(ip, bucket, limit, windowMs) {
  if (!ip) return { allowed: true, retryAfter: 0 };
  return checkLocalRateLimit(`web-local-ip:${bucket}:${ip}`, limit, windowMs);
}

const limits = {
  general:    { limit: 60,  windowMs: 60 * 1000 },
  cards:      { limit: 120, windowMs: 60 * 60 * 1000 },
  save:       { limit: 60,  windowMs: 24 * 60 * 60 * 1000 },
  imageSave:  { limit: IMAGE_SAVE_DAILY_LIMIT, windowMs: 24 * 60 * 60 * 1000 },
  unlock:     { limit: 8,   windowMs: 15 * 60 * 1000 },
  gmailStatus:{ limit: 40,  windowMs: 60 * 1000 },
  gmailConnect:{ limit: 5,  windowMs: 60 * 60 * 1000 },
  gmailSync:  { limit: GMAIL_SYNC_HOURLY_LIMIT, windowMs: 60 * 60 * 1000 },
  gmailComplete:{ limit: 12, windowMs: 60 * 60 * 1000 },
  aiText:     { limit: AI_TEXT_DAILY_LIMIT, windowMs: 24 * 60 * 60 * 1000 },
  pinChange:  { limit: 5,   windowMs: 60 * 60 * 1000 },
  legacyExport:{ limit: 3,  windowMs: 60 * 60 * 1000 },
};

const ipLimits = {
  unlockBurst:  { limit: 20, windowMs: 15 * 60 * 1000 },
  authBurst:    { limit: 30, windowMs: 60 * 1000 },
  globalBurst:  { limit: 300, windowMs: 60 * 1000 },
};

const localIpLimits = {
  apiBurst:       { limit: 120, windowMs: 60 * 1000 },
  statusBurst:    { limit: 30,  windowMs: 60 * 1000 },
  expensiveBurst: { limit: 10,  windowMs: 60 * 1000 },
};

module.exports = {
  addSecurityHeaders,
  getClientIp,
  isWebUserBlocked,
  checkUserRateLimit,
  checkIpRateLimit,
  checkLocalIpRateLimit,
  limits,
  ipLimits,
  localIpLimits,
};
