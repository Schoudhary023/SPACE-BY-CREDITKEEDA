const bcrypt = require("bcryptjs");
const { track } = require("./analytics");
const { supabase, withSupabaseRetry } = require("./supabase");

// ============================================================
// PIN SECURITY MODEL — HOW THE VAULT PIN IS HANDLED
// ============================================================
//
// The vault PIN is NEVER stored in plaintext, anywhere. Here is what is stored:
//
//   users_vault.vault_pin_hash  — a bcrypt hash (cost 12) of the raw PIN.
//                                  bcrypt hashes are irreversible; we cannot
//                                  recover the PIN from this hash.
//
// The raw PIN only exists in two places, neither of which is the database:
//   1. In the user's head (or password manager).
//   2. In the in-memory activeSessions Map (in handlers/session.js) for the
//      duration of an active session (30 minutes). This Map is never written
//      to disk, never logged, and is cleared on server restart.
//
// This means:
//   - A full database dump reveals only bcrypt hashes — not recoverable.
//   - A server restart forces all users to re-enter their PIN.
//   - The encryption key for card data is derived from the PIN at runtime
//     (see lib/crypto.js) and also never stored.
//
// PIN verification (verifyVaultPin):
//   - Uses bcrypt.compare — constant-time comparison.
//   - Tracks failed attempts in the DB and applies escalating lockouts.
//   - On success, resets failed_attempts to 0 and returns the encryption_salt
//     so the caller can derive the decryption key.
// ============================================================

const SESSION_MS = 30 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 3;

// Escalating lockout: each cycle of MAX_FAILED_ATTEMPTS increases duration.
// totalAttempts accumulates across lockouts and resets only after success.
function getLockoutDuration(totalAttempts) {
  if (totalAttempts >= 15) return 24 * 60 * 60 * 1000; // 24 h
  if (totalAttempts >= 12) return 4 * 60 * 60 * 1000;  // 4 h
  if (totalAttempts >= 9)  return 60 * 60 * 1000;       // 1 h
  if (totalAttempts >= 6)  return 30 * 60 * 1000;       // 30 min
  return 15 * 60 * 1000;                                 // 15 min
}

function buildVaultAuthSelect() {
  return "user_uuid, telegram_id, auth_user_id, email, vault_pin_hash, failed_attempts, locked_until, encryption_salt";
}

async function getVaultAuthByTelegramId(telegramId) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select(buildVaultAuthSelect())
      .eq("telegram_id", String(telegramId))
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  return data || null;
}

async function getVaultAuthByUserUuid(userUuid) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select(buildVaultAuthSelect())
      .eq("user_uuid", String(userUuid))
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  return data || null;
}

async function updateVaultAuthByUserUuid(userUuid, patch) {
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .update(patch)
      .eq("user_uuid", String(userUuid))
  );

  if (error) {
    throw error;
  }
}

async function verifyVaultPin(user, pin, { trackUserId = null } = {}) {
  if (!user) {
    return { ok: false, status: "missing_user" };
  }

  const now = new Date();
  if (user.locked_until && new Date(user.locked_until) > now) {
    const retryAfterMinutes = Math.max(1, Math.ceil((new Date(user.locked_until).getTime() - now.getTime()) / 60000));
    return {
      ok: false,
      status: "locked",
      retryAfterMinutes,
    };
  }

  const isValidPin = await bcrypt.compare(String(pin || ""), user.vault_pin_hash);

  if (!isValidPin) {
    const nextAttempts = (user.failed_attempts ?? 0) + 1;
    const remainder = nextAttempts % MAX_FAILED_ATTEMPTS;
    const attemptsRemaining = remainder === 0 ? 0 : MAX_FAILED_ATTEMPTS - remainder;
    const updatePayload = { failed_attempts: nextAttempts };
    let lockoutMinutes = null;

    if (remainder === 0) {
      const lockoutMs = getLockoutDuration(nextAttempts);
      lockoutMinutes = Math.round(lockoutMs / 60000);
      updatePayload.locked_until = new Date(now.getTime() + lockoutMs).toISOString();
      if (trackUserId) {
        track("user.locked_out", trackUserId, { lockout_minutes: lockoutMinutes });
      }
    }

    await updateVaultAuthByUserUuid(user.user_uuid, updatePayload);

    if (trackUserId) {
      track("user.login_failed", trackUserId, { attempt: nextAttempts });
    }

    return {
      ok: false,
      status: "invalid_pin",
      attemptsRemaining,
      lockoutMinutes,
    };
  }

  await updateVaultAuthByUserUuid(user.user_uuid, {
    failed_attempts: 0,
    locked_until: null,
  });

  return {
    ok: true,
    status: "valid",
    encryptionSalt: String(user.encryption_salt),
  };
}

module.exports = {
  SESSION_MS,
  getVaultAuthByTelegramId,
  getVaultAuthByUserUuid,
  verifyVaultPin,
};
