const crypto = require("crypto");
const { SESSION_MS } = require("../lib/vaultSessions");

const webVaultSessions = new Map();
const VAULT_SESSION_COOKIE = "kv_vault_session";

function createWebVaultSession({ authUserId, userUuid, encryptionSalt }) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MS);

  webVaultSessions.set(token, {
    authUserId: String(authUserId),
    userUuid: String(userUuid),
    encryptionSalt,
    expiresAt,
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

function getCookieValue(req, name) {
  const cookieHeader = String(req.headers.cookie || "");
  const cookies = cookieHeader.split(";").map((part) => part.trim()).filter(Boolean);
  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = cookie.slice(0, separatorIndex).trim();
    if (key === name) {
      return decodeURIComponent(cookie.slice(separatorIndex + 1));
    }
  }

  return "";
}

function getVaultSessionToken(req) {
  return String(req.headers["x-vault-session-token"] || getCookieValue(req, VAULT_SESSION_COOKIE) || "").trim();
}

function getWebVaultSession(token, { authUserId = null, userUuid = null } = {}) {
  if (!token) {
    return null;
  }

  const session = webVaultSessions.get(String(token));
  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    webVaultSessions.delete(String(token));
    return null;
  }

  if (authUserId && session.authUserId !== String(authUserId)) {
    return null;
  }

  if (userUuid && session.userUuid !== String(userUuid)) {
    return null;
  }

  return session;
}

function deleteWebVaultSession(token) {
  if (!token) {
    return false;
  }

  return webVaultSessions.delete(String(token));
}

function deleteAllWebVaultSessionsForUserUuid(userUuid) {
  if (!userUuid) return 0;
  const target = String(userUuid);
  let removed = 0;
  for (const [token, session] of webVaultSessions.entries()) {
    if (session.userUuid === target) {
      webVaultSessions.delete(token);
      removed += 1;
    }
  }
  return removed;
}

function cleanupExpiredWebVaultSessions() {
  const now = Date.now();
  for (const [token, session] of webVaultSessions.entries()) {
    if (session.expiresAt.getTime() <= now) {
      webVaultSessions.delete(token);
    }
  }
}

setInterval(cleanupExpiredWebVaultSessions, 5 * 60 * 1000).unref();

module.exports = {
  VAULT_SESSION_COOKIE,
  createWebVaultSession,
  deleteAllWebVaultSessionsForUserUuid,
  deleteWebVaultSession,
  getVaultSessionToken,
  getWebVaultSession,
};
