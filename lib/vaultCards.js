const { decrypt, encrypt } = require("./crypto");
const { hashUserId, track } = require("./analytics");
const { normalizeBrandKey } = require("./cardDisplay");
const { logError, logInfo, logWarn } = require("./logger");
const { supabase, withSupabaseRetry } = require("./supabase");
const { getUserByTelegramId, getUserByUserUuid } = require("./vaultUsers");

const EXPIRY_TIMEZONE = process.env.EXPIRY_REMINDER_TIMEZONE;

function getTodayIsoInTimezone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EXPIRY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeGiftCardCode(code) {
  return String(code || "").trim();
}

const CANONICAL_SOURCES = new Set(["manual", "ai_text", "image", "gmail"]);
const CRYPTO_MODE_SERVER = "server";
const CRYPTO_MODE_CLIENT = "client";

function normalizeCardSource(raw) {
  if (!raw) return "manual";
  const value = String(raw).toLowerCase();
  if (CANONICAL_SOURCES.has(value)) return value;
  if (value === "fields" || value === "web_fields") return "manual";
  if (value.startsWith("image") || value.includes("_image")) return "image";
  if (value.startsWith("gmail")) return "gmail";
  if (
    value.startsWith("text") ||
    value.startsWith("web_") ||
    value.includes("vertex") ||
    value.includes("local") ||
    value.includes("ai")
  ) {
    return "ai_text";
  }
  return "manual";
}

async function logCardEvent(telegramId, cardId, eventType, metadata = {}) {
  const user = await getUserByTelegramId(telegramId);
  const { error } = await withSupabaseRetry(() =>
    supabase.from("card_events_vault").insert({
      telegram_id: telegramId,
      user_uuid: user?.user_uuid || null,
      card_id: cardId || null,
      event_type: eventType,
      metadata,
    })
  );

  if (error) {
    logWarn("Failed to write card event", { telegramId, cardId, eventType, error: error.message });
  }
}

async function logCardEventForUserUuid(userUuid, cardId, eventType, metadata = {}) {
  const user = await getUserByUserUuid(userUuid);
  const { error } = await withSupabaseRetry(() =>
    supabase.from("card_events_vault").insert({
      telegram_id: user?.telegram_id || null,
      user_uuid: String(userUuid),
      card_id: cardId || null,
      event_type: eventType,
      metadata,
    })
  );

  if (error) {
    logWarn("Failed to write web card event", { userUuid, cardId, eventType, error: error.message });
  }
}

async function fetchCards(telegramId, { includeRedeemed = false, searchTerm = null } = {}) {
  let query = supabase
    .from("gift_cards_vault")
    .select("id, brand, amount, code_encrypted, pin_encrypted, expiry_date, is_redeemed, created_at, source, crypto_mode, crypto_version, code_fingerprint")
    .eq("telegram_id", telegramId);

  if (!includeRedeemed) {
    query = query.eq("is_redeemed", false);
    const todayIso = getTodayIsoInTimezone();
    query = query.or(`expiry_date.is.null,expiry_date.gte.${todayIso}`);
  }

  if (searchTerm) {
    query = query.ilike("brand", `%${searchTerm}%`);
  }

  query = query.order("created_at", { ascending: false }).order("id", { ascending: false });

  const { data, error } = await withSupabaseRetry(() => query);

  if (error) {
    throw error;
  }

  return data || [];
}

async function fetchCardsByUserUuid(userUuid, { includeRedeemed = false, searchTerm = null } = {}) {
  let query = supabase
    .from("gift_cards_vault")
    .select("id, user_uuid, telegram_id, brand, amount, code_encrypted, pin_encrypted, expiry_date, is_redeemed, created_at, redeemed_at, source, crypto_mode, crypto_version, code_fingerprint")
    .eq("user_uuid", String(userUuid));

  if (!includeRedeemed) {
    query = query.eq("is_redeemed", false);
    const todayIso = getTodayIsoInTimezone();
    query = query.or(`expiry_date.is.null,expiry_date.gte.${todayIso}`);
  }

  if (searchTerm) {
    query = query.ilike("brand", `%${searchTerm}%`);
  }

  query = query.order("created_at", { ascending: false }).order("id", { ascending: false });

  const { data, error } = await withSupabaseRetry(() => query);

  if (error) {
    throw error;
  }

  return data || [];
}

async function decryptCardSecrets(card, vaultPin, encryptionSalt) {
  const decryptedCode = await decrypt(card.code_encrypted, vaultPin, encryptionSalt);
  const decryptedPin = card.pin_encrypted ? await decrypt(card.pin_encrypted, vaultPin, encryptionSalt) : null;

  return { decryptedCode, decryptedPin };
}

async function findDuplicateCard(telegramId, vaultPin, encryptionSalt, brand, code) {
  const existingCards = await fetchCards(telegramId, { includeRedeemed: true });
  const targetBrandKey = normalizeBrandKey(brand);
  const targetCode = normalizeGiftCardCode(code);

  for (const card of existingCards) {
    if (normalizeBrandKey(card.brand) !== targetBrandKey) {
      continue;
    }

    try {
      const decryptedCode = await decrypt(card.code_encrypted, vaultPin, encryptionSalt);
      if (normalizeGiftCardCode(decryptedCode) === targetCode) {
        return card;
      }
    } catch (error) {
      logError("Duplicate card check decryption error", error, { telegramId, cardId: card.id });
    }
  }

  return null;
}

async function findDuplicateCardByUserUuid(userUuid, vaultPin, encryptionSalt, brand, code) {
  const existingCards = await fetchCardsByUserUuid(userUuid, { includeRedeemed: true });
  const targetBrandKey = normalizeBrandKey(brand);
  const targetCode = normalizeGiftCardCode(code);

  for (const card of existingCards) {
    if (normalizeBrandKey(card.brand) !== targetBrandKey) {
      continue;
    }

    try {
      const decryptedCode = await decrypt(card.code_encrypted, vaultPin, encryptionSalt);
      if (normalizeGiftCardCode(decryptedCode) === targetCode) {
        return card;
      }
    } catch (error) {
      logError("Duplicate card check decryption error", error, { userUuid, cardId: card.id });
    }
  }

  return null;
}

async function saveCard(telegramId, vaultPin, encryptionSalt, parsed, source = "text") {
  const user = await getUserByTelegramId(telegramId);
  const codeEncrypted = await encrypt(parsed.code, vaultPin, encryptionSalt);
  const pinEncrypted = parsed.pin ? await encrypt(parsed.pin, vaultPin, encryptionSalt) : null;
  const canonicalSource = normalizeCardSource(source);

  const { data: inserted, error } = await withSupabaseRetry(() =>
    supabase.from("gift_cards_vault").insert({
      telegram_id: telegramId,
      user_uuid: user?.user_uuid || null,
      brand: parsed.brand,
      amount: parsed.amount,
      code_encrypted: codeEncrypted,
      pin_encrypted: pinEncrypted,
      expiry_date: parsed.expiryDate || null,
      source: canonicalSource,
      crypto_mode: CRYPTO_MODE_SERVER,
      crypto_version: 1,
    }).select("id").single()
  );

  if (error) {
    throw error;
  }

  logInfo("Card saved", { telegramId, cardId: inserted.id, brand: parsed.brand, amount: parsed.amount, source: canonicalSource });
  logCardEvent(telegramId, inserted.id, "saved", { brand: parsed.brand, amount: parsed.amount, source: canonicalSource }).catch(() => {});
  track("card.saved", telegramId, { brand: parsed.brand, amount: parsed.amount, source: canonicalSource });
  return inserted;
}

async function saveCardForUserUuid(userUuid, vaultPin, encryptionSalt, parsed, source = "web") {
  const user = await getUserByUserUuid(userUuid);
  const codeEncrypted = await encrypt(parsed.code, vaultPin, encryptionSalt);
  const pinEncrypted = parsed.pin ? await encrypt(parsed.pin, vaultPin, encryptionSalt) : null;
  const canonicalSource = normalizeCardSource(source);

  const { data: inserted, error } = await withSupabaseRetry(() =>
    supabase.from("gift_cards_vault").insert({
      telegram_id: user?.telegram_id || null,
      user_uuid: String(userUuid),
      brand: parsed.brand,
      amount: parsed.amount,
      code_encrypted: codeEncrypted,
      pin_encrypted: pinEncrypted,
      expiry_date: parsed.expiryDate || null,
      source: canonicalSource,
      crypto_mode: CRYPTO_MODE_SERVER,
      crypto_version: 1,
    }).select("id").single()
  );

  if (error) {
    throw error;
  }

  logInfo("Card saved", { userUuid, cardId: inserted.id, brand: parsed.brand, amount: parsed.amount, source: canonicalSource });
  logCardEventForUserUuid(userUuid, inserted.id, "saved", { brand: parsed.brand, amount: parsed.amount, source: canonicalSource }).catch(() => {});
  track("card.saved", user?.telegram_id || String(userUuid), { brand: parsed.brand, amount: parsed.amount, source: canonicalSource });
  return inserted;
}

// Both fingerprint formats are unpadded-free standard base64 of a 32-byte
// SHA-256 digest — exactly 43 base64 chars plus one `=` padding character.
// Any deviation means the client-supplied value is malformed (or hostile) and
// must not be interpolated into a PostgREST filter expression.
const FINGERPRINT_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

function isValidFingerprint(value) {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

async function findDuplicateEncryptedCardByUserUuid(userUuid, brand, fingerprints) {
  // Accepts either a bare v1 fingerprint string (legacy callers) or an object
  // { v1, v2 } so we can match against existing rows that carry either column.
  // During the v1→v2 migration window, some rows have only v1, some have both,
  // and new rows have v2 — duplicate detection must catch all of those.
  const rawV1 = typeof fingerprints === "string"
    ? fingerprints
    : (fingerprints && fingerprints.v1) || "";
  const rawV2 = typeof fingerprints === "string"
    ? ""
    : (fingerprints && fingerprints.v2) || "";

  // Validate format before building any filter. Even though the surrounding
  // `.eq("user_uuid", ...)` prevents cross-user reads, an unsanitized
  // fingerprint with `,` or `.` could alter or break the PostgREST `.or()`
  // expression. Reject malformed input outright — there's no legitimate
  // reason a client would ever send a non-base64 SHA-256 here.
  const v1 = isValidFingerprint(rawV1) ? rawV1 : "";
  const v2 = isValidFingerprint(rawV2) ? rawV2 : "";
  if (!v1 && !v2) return null;

  const filters = [];
  if (v1) filters.push(`code_fingerprint.eq.${v1}`);
  if (v2) filters.push(`code_fingerprint_v2.eq.${v2}`);

  // A fingerprint may repeat across brands, so fetch all matches and pick the
  // one whose brand matches. Using maybeSingle() here would throw if two cards
  // shared a fingerprint, turning a benign duplicate check into a 500 on save.
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .select("id, brand, amount")
      .eq("user_uuid", String(userUuid))
      .or(filters.join(","))
      .limit(20)
  );

  if (error) {
    throw error;
  }

  const rows = data || [];
  if (!rows.length) return null;
  const targetBrandKey = normalizeBrandKey(brand);
  return rows.find((row) => normalizeBrandKey(row.brand) === targetBrandKey) || null;
}

async function saveEncryptedCardForUserUuid(userUuid, parsed, source = "web") {
  const user = await getUserByUserUuid(userUuid);
  const canonicalSource = normalizeCardSource(source);

  // crypto_version mirrors the ciphertext prefix so future migrations can
  // filter on it. After P0.1, all new writes are client-v2; the upgrade
  // recrypt endpoint also writes version 2. Only pre-P0.1 rows remain at
  // version 1 until they're recrypted on read.
  const cryptoVersion = String(parsed.codeEncrypted).startsWith("client-v2:") ? 2 : 1;

  const { data: inserted, error } = await withSupabaseRetry(() =>
    supabase.from("gift_cards_vault").insert({
      telegram_id: user?.telegram_id || null,
      user_uuid: String(userUuid),
      brand: parsed.brand,
      amount: parsed.amount,
      code_encrypted: parsed.codeEncrypted,
      pin_encrypted: parsed.pinEncrypted || null,
      expiry_date: parsed.expiryDate || null,
      source: canonicalSource,
      crypto_mode: CRYPTO_MODE_CLIENT,
      crypto_version: cryptoVersion,
      code_fingerprint: parsed.codeFingerprint || null,
      code_fingerprint_v2: parsed.codeFingerprintV2 || null,
    }).select("id").single()
  );

  if (error) {
    throw error;
  }

  logInfo("Encrypted card saved", { userUuid, cardId: inserted.id, brand: parsed.brand, amount: parsed.amount, source: canonicalSource });
  logCardEventForUserUuid(userUuid, inserted.id, "saved", { brand: parsed.brand, amount: parsed.amount, source: canonicalSource, cryptoMode: CRYPTO_MODE_CLIENT }).catch(() => {});
  track("card.saved", user?.telegram_id || String(userUuid), { brand: parsed.brand, amount: parsed.amount, source: canonicalSource, crypto_mode: CRYPTO_MODE_CLIENT });
  return inserted;
}

async function updateEncryptedCardForUserUuid(cardId, userUuid, encrypted) {
  const cryptoVersion = String(encrypted.codeEncrypted || "").startsWith("client-v2:") ? 2 : 1;

  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .update({
        code_encrypted: encrypted.codeEncrypted,
        pin_encrypted: encrypted.pinEncrypted || null,
        crypto_mode: CRYPTO_MODE_CLIENT,
        crypto_version: cryptoVersion,
        code_fingerprint: encrypted.codeFingerprint || null,
        code_fingerprint_v2: encrypted.codeFingerprintV2 || null,
      })
      .eq("id", cardId)
      .eq("user_uuid", String(userUuid))
      .eq("crypto_mode", CRYPTO_MODE_SERVER)
      .select("id")
      .maybeSingle()
  );

  if (error) {
    throw error;
  }

  return data || null;
}

// Used by the in-place v1 -> v2 ciphertext upgrade on the web. Unlike
// `updateEncryptedCardForUserUuid` (which only fires on server -> client
// transitions), this updates an already-client-mode row's ciphertext to the
// freshly-re-encrypted v2 form. It does NOT change `crypto_mode` — the row
// is already client-mode — and does NOT accept v1 ciphertext, to prevent a
// stale or compromised client from downgrading a row.
async function recryptClientCardForUserUuid(cardId, userUuid, encrypted) {
  if (typeof encrypted?.codeEncrypted !== "string" || !encrypted.codeEncrypted.startsWith("client-v2:")) {
    return null;
  }
  if (encrypted.pinEncrypted && !String(encrypted.pinEncrypted).startsWith("client-v2:")) {
    return null;
  }
  // A v1 -> v2 upgrade must always carry the salted fingerprint. Without it
  // the row would land at v2 ciphertext but with only the unsalted v1
  // fingerprint, silently regressing duplicate-detection protection.
  if (!isValidFingerprint(encrypted.codeFingerprintV2)) {
    return null;
  }

  const update = {
    code_encrypted: encrypted.codeEncrypted,
    pin_encrypted: encrypted.pinEncrypted || null,
    crypto_version: 2,
    code_fingerprint_v2: encrypted.codeFingerprintV2,
  };

  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .update(update)
      .eq("id", cardId)
      .eq("user_uuid", String(userUuid))
      .eq("crypto_mode", CRYPTO_MODE_CLIENT)
      .select("id")
      .maybeSingle()
  );

  if (error) throw error;
  return data || null;
}

async function fetchCardById(cardId, telegramId) {
  const { data, error } = await supabase
    .from("gift_cards_vault")
    .select("id, brand, amount")
    .eq("id", cardId)
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function fetchCardByIdForUserUuid(cardId, userUuid) {
  const { data, error } = await supabase
    .from("gift_cards_vault")
    .select("id, user_uuid, telegram_id, brand, amount, code_encrypted, pin_encrypted, expiry_date, is_redeemed, created_at, redeemed_at, source, crypto_mode, crypto_version, code_fingerprint")
    .eq("id", cardId)
    .eq("user_uuid", String(userUuid))
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function deleteSingleCardData(cardId, telegramId) {
  const { error: reminderError } = await withSupabaseRetry(() =>
    supabase
      .from("expiry_reminders_vault")
      .delete()
      .eq("gift_card_id", cardId)
      .eq("telegram_id", telegramId)
  );

  if (reminderError) {
    throw reminderError;
  }

  const { error: eventError } = await withSupabaseRetry(() =>
    supabase
      .from("card_events_vault")
      .delete()
      .eq("card_id", cardId)
      .eq("telegram_id", telegramId)
  );

  if (eventError) {
    throw eventError;
  }

  const { error: cardError } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .delete()
      .eq("id", cardId)
      .eq("telegram_id", telegramId)
  );

  if (cardError) {
    throw cardError;
  }
}

async function deleteSingleCardDataForUserUuid(cardId, userUuid) {
  const { error: reminderError } = await withSupabaseRetry(() =>
    supabase
      .from("expiry_reminders_vault")
      .delete()
      .eq("gift_card_id", cardId)
      .eq("user_uuid", String(userUuid))
  );

  if (reminderError) {
    throw reminderError;
  }

  const { error: eventError } = await withSupabaseRetry(() =>
    supabase
      .from("card_events_vault")
      .delete()
      .eq("card_id", cardId)
      .eq("user_uuid", String(userUuid))
  );

  if (eventError) {
    throw eventError;
  }

  const { error: cardError } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .delete()
      .eq("id", cardId)
      .eq("user_uuid", String(userUuid))
  );

  if (cardError) {
    throw cardError;
  }
}

async function markCardRedeemedForUserUuid(cardId, userUuid) {
  const redeemedAt = new Date().toISOString();
  const card = await fetchCardByIdForUserUuid(cardId, userUuid);

  if (!card) {
    return null;
  }

  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .update({ is_redeemed: true, redeemed_at: redeemedAt })
      .eq("id", cardId)
      .eq("user_uuid", String(userUuid))
  );

  if (error) {
    throw error;
  }

  await logCardEventForUserUuid(userUuid, cardId, "redeemed", {
    brand: card.brand,
    amount: card.amount,
    redeemedAt,
  });

  return {
    ...card,
    is_redeemed: true,
    redeemed_at: redeemedAt,
  };
}

async function deleteAllCardsData(telegramId) {
  const { error } = await withSupabaseRetry(() =>
    supabase.rpc("delete_all_cards_vault", {
      p_telegram_id: telegramId,
    })
  );

  if (error) {
    throw error;
  }
}

async function resetVaultDataForUserUuid(userUuid, { authUserId, email } = {}) {
  // Disconnect Gmail (revokes token, clears oauth state, accounts, processed messages)
  try {
    const { disconnectGmailForOwner } = require("./gmailSync");
    await disconnectGmailForOwner({ userUuid, telegramId: null }, { clearProcessed: true });
  } catch {
    // Gmail may not be connected — proceed regardless
  }

  const { error } = await withSupabaseRetry(() =>
    supabase.from("gift_cards_vault").delete().eq("user_uuid", String(userUuid))
  );
  if (error) throw error;

  // Build OR filter covering all known keys so the row is deleted regardless
  // of which columns happen to be populated on this particular row.
  const conditions = [`user_uuid.eq.${String(userUuid)}`];
  if (authUserId) conditions.push(`auth_user_id.eq.${String(authUserId)}`);
  if (email) conditions.push(`email.ilike.${String(email)}`);

  const { error: userError } = await withSupabaseRetry(() =>
    supabase.from("users_vault").delete().or(conditions.join(","))
  );
  if (userError) throw userError;
}

async function changePinForUserUuid(userUuid, newPinHash, encryptedCards) {
  for (const card of encryptedCards) {
    const { error } = await withSupabaseRetry(() =>
      supabase
        .from("gift_cards_vault")
        .update({
          code_encrypted: card.codeEncrypted,
          pin_encrypted: card.pinEncrypted || null,
          code_fingerprint_v2: card.codeFingerprintV2 || null,
          crypto_version: 2,
        })
        .eq("id", card.id)
        .eq("user_uuid", String(userUuid))
    );
    if (error) throw Object.assign(error, { failedCardId: card.id });
  }

  const { error: pinError } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .update({ vault_pin_hash: newPinHash, failed_attempts: 0, locked_until: null })
      .eq("user_uuid", String(userUuid))
  );
  if (pinError) throw pinError;
}

async function deleteAccountData(telegramId) {
  const { error } = await withSupabaseRetry(() =>
    supabase.rpc("delete_account_vault", {
      p_telegram_id: telegramId,
      p_user_hash: hashUserId(telegramId),
    })
  );

  if (error) {
    throw error;
  }
}

async function deleteAccountDataByUserUuid(userUuid, { telegramId = null } = {}) {
  const hashSeed = telegramId || userUuid;
  const { error } = await withSupabaseRetry(() =>
    supabase.rpc("delete_account_by_user_uuid_vault", {
      p_user_uuid: userUuid,
      p_user_hash: hashSeed ? hashUserId(hashSeed) : null,
    })
  );

  if (error) {
    throw error;
  }
}

module.exports = {
  decryptCardSecrets,
  deleteAccountData,
  deleteAccountDataByUserUuid,
  deleteAllCardsData,
  deleteSingleCardData,
  deleteSingleCardDataForUserUuid,
  fetchCardById,
  fetchCardByIdForUserUuid,
  fetchCards,
  fetchCardsByUserUuid,
  findDuplicateCard,
  findDuplicateCardByUserUuid,
  findDuplicateEncryptedCardByUserUuid,
  isValidFingerprint,
  logCardEvent,
  logCardEventForUserUuid,
  markCardRedeemedForUserUuid,
  normalizeGiftCardCode,
  recryptClientCardForUserUuid,
  resetVaultDataForUserUuid,
  changePinForUserUuid,
  saveCard,
  saveEncryptedCardForUserUuid,
  saveCardForUserUuid,
  updateEncryptedCardForUserUuid,
};
