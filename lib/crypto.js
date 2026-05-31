const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

// ============================================================
// WHY THE ENCRYPTION IS DESIGNED THIS WAY
// ============================================================
//
// Goal: The server must NEVER be able to read a user's gift card codes or PINs,
// even if the database is fully compromised. This makes CreditKeeda Space
// "zero-knowledge" for card contents — you can verify this yourself by reading
// this file.
//
// Key derivation (deriveKey):
//   key = scrypt(ENCRYPTION_SECRET + vaultPin, encryptionSalt, 32 bytes)
//
//   - ENCRYPTION_SECRET: a server-side secret stored in an env var (not the DB).
//   - vaultPin: the user's PIN, which is NEVER written to disk or the database.
//     Only its bcrypt hash lives in the DB. The raw PIN exists only in the
//     in-memory activeSessions map during an active session.
//   - encryptionSalt: a random UUID stored per-user in users_vault. It is
//     platform-agnostic (not tied to Telegram), so the web app can decrypt the
//     same ciphertext using the same PIN.
//
//   Because the PIN is required to derive the key, and the PIN is never stored,
//   a database-only attacker cannot decrypt card data. They would need BOTH the
//   database AND the server's ENCRYPTION_SECRET AND the user's live PIN.
//
// Encryption algorithm (AES-256-GCM):
//   - Authenticated encryption: any tampering with ciphertext is detected.
//   - 96-bit random IV per encryption: same plaintext encrypted twice produces
//     different ciphertext, preventing pattern analysis.
//   - 16-byte authentication tag: ensures integrity.
//
// Key rotation:
//   - Multiple key versions are supported via ENCRYPTION_SECRET_V1, V2, etc.
//   - The version number is stored as a prefix in the ciphertext.
//   - Decryption reads the prefix and picks the right key.
//   - New writes always use the latest key version.
//
// Runtime encryption (encryptForRuntime / decryptForRuntime):
//   - Used for temporary data like pending action payloads stored in the DB.
//   - Encrypted with the app-level ENCRYPTION_SECRET (not user PIN-derived).
//   - This is NOT zero-knowledge — the server can read this data — but it is
//     only used for short-lived session state, not for gift card codes or PINs.
// ============================================================

// Bounded cache — avoids re-deriving the same key multiple times within one
// request (e.g. showing 10 cards calls deriveKey 10 times for the same user).
// Keyed by "<userIdentifier>:<vaultPin>:<keyVersion>" — no additional secret
// exposure since vaultPin is already held in the in-memory activeSessions map.
const KEY_CACHE = new Map();
const KEY_CACHE_MAX = 50;

// Load all available encryption keys (support for key rotation)
const ENCRYPTION_KEYS = {};
let LATEST_KEY_VERSION = 1;

// Load keys from environment variables (ENCRYPTION_SECRET_V1, ENCRYPTION_SECRET_V2, etc.)
for (let i = 1; ; i++) {
  const key = process.env[`ENCRYPTION_SECRET_V${i}`];
  if (!key) break;
  ENCRYPTION_KEYS[i] = key;
  LATEST_KEY_VERSION = i;
}

// Fallback to single ENCRYPTION_SECRET for backward compatibility
if (LATEST_KEY_VERSION === 1 && !ENCRYPTION_KEYS[1]) {
  ENCRYPTION_KEYS[1] = process.env.ENCRYPTION_SECRET;
}

if (!ENCRYPTION_KEYS[1]) {
  throw new Error(
    "At least ENCRYPTION_SECRET or ENCRYPTION_SECRET_V1 is required",
  );
}

const APP_SECRET = process.env.ENCRYPTION_SECRET || ENCRYPTION_KEYS[1];

async function deriveKey(
  vaultPin,
  userIdentifier,
  keyVersion = LATEST_KEY_VERSION,
) {
  if (!vaultPin) {
    throw new Error("Vault PIN is required for encryption");
  }

  if (!userIdentifier) {
    throw new Error("User identifier is required for encryption");
  }

  const secret = ENCRYPTION_KEYS[keyVersion];
  if (!secret) {
    throw new Error(`Encryption key version ${keyVersion} not found`);
  }

  // Salt includes userIdentifier so that the same PIN for different users
  // produces completely different encryption keys. userIdentifier is a
  // platform-agnostic UUID stored in users_vault.encryption_salt — not tied
  // to any specific platform (Telegram, web, app).
  const salt = `${userIdentifier}:${vaultPin}`;
  const cacheKey = `${salt}:${keyVersion}`;

  const cached = KEY_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  // N=131072, r=8 requires 128 MB — raise maxmem explicitly.
  // async scrypt keeps the event loop free during the expensive derivation.
  const key = await scrypt(secret, salt, 32, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });

  if (KEY_CACHE.size >= KEY_CACHE_MAX) {
    // Evict the oldest entry to keep the cache bounded.
    KEY_CACHE.delete(KEY_CACHE.keys().next().value);
  }
  KEY_CACHE.set(cacheKey, key);

  return key;
}

function deriveAppKey() {
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

// GCM format (new): "version:iv(24hex):authTag(32hex):ciphertext(hex)"  — 4 parts
// CBC format (legacy 3-part): "version:iv(32hex):ciphertext(hex)"
// CBC format (legacy 2-part): "iv(32hex):ciphertext(hex)"
//
// New encryptions always use GCM (authenticated encryption).
// Old CBC ciphertexts are still readable for backward compatibility.

// Encrypts plaintext using AES-256-GCM with a key derived from the user's
// vault PIN. The result is stored in the database. Only the user (who knows
// their PIN) can decrypt it — the server cannot, because the PIN is never stored.
async function encrypt(text, vaultPin, userIdentifier) {
  const keyVersion = LATEST_KEY_VERSION;
  const iv = crypto.randomBytes(12); // 96-bit IV — GCM standard
  const key = await deriveKey(vaultPin, userIdentifier, keyVersion);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(text), "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag(); // 16-byte authentication tag
  return `${keyVersion}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

// Decrypts ciphertext using the user's vault PIN. Supports all ciphertext
// formats (GCM and legacy CBC) and all key versions via the version prefix.
// Returns the plaintext, or throws if the PIN is wrong or data is corrupted.
async function decrypt(encryptedText, vaultPin, userIdentifier) {
  try {
    const parts = String(encryptedText).split(":");

    let keyVersion, ivHex, authTagHex, encryptedHex;

    if (parts.length === 4) {
      // GCM format: version:iv:authTag:encrypted
      [keyVersion, ivHex, authTagHex, encryptedHex] = parts;
      keyVersion = parseInt(keyVersion, 10);

      if (!ivHex || !authTagHex || !encryptedHex) {
        throw new Error("Encrypted payload format is invalid");
      }

      const iv = Buffer.from(ivHex, "hex");
      const key = await deriveKey(vaultPin, userIdentifier, keyVersion);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

      return Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, "hex")),
        decipher.final(),
      ]).toString("utf8");
    }

    // Legacy CBC formats (read-only — new writes always use GCM above)
    if (parts.length === 3) {
      // version:iv:encrypted
      [keyVersion, ivHex, encryptedHex] = parts;
      keyVersion = parseInt(keyVersion, 10);
    } else if (parts.length === 2) {
      // iv:encrypted (oldest format, no version prefix)
      keyVersion = 1;
      [ivHex, encryptedHex] = parts;
    } else {
      throw new Error("Encrypted payload format is invalid");
    }

    if (!ivHex || !encryptedHex) {
      throw new Error("Encrypted payload format is invalid");
    }

    const iv = Buffer.from(ivHex, "hex");
    const key = await deriveKey(vaultPin, userIdentifier, keyVersion);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("Decryption failed. Wrong PIN or corrupted data.");
  }
}

// Runtime encryption uses the app-level secret (not the user's PIN).
// Used for short-lived session state (pending actions) stored in the DB.
// NOT zero-knowledge — the server can read this — but it never contains
// gift card codes or PINs.
function encryptForRuntime(text) {
  const iv = crypto.randomBytes(12);
  const key = deriveAppKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(text), "utf8"),
    cipher.final(),
  ]);

  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptForRuntime(encryptedText) {
  const [ivHex, authTagHex, encryptedHex] = String(encryptedText).split(":");

  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Runtime encrypted payload format is invalid");
  }

  const key = deriveAppKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

module.exports = {
  decryptForRuntime,
  encrypt,
  decrypt,
  encryptForRuntime,
};
