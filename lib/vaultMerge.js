const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { normalizeBrandKey } = require("./cardDisplay");
const { decrypt, encrypt } = require("./crypto");
const { logInfo } = require("./logger");
const { supabase, withSupabaseRetry } = require("./supabase");
const { forgetUserByAuthUserId, forgetUserByTelegramId, getUserByUserUuid } = require("./vaultUsers");

const MERGE_TOKEN_TTL_MS = 15 * 60 * 1000;
const PIN_REGEX = /^\d{6,20}$/;

function getMergeSecret() {
  const secret = process.env.MERGE_TOKEN_SECRET || process.env.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET_V1;
  if (!secret) {
    throw new Error("MERGE_TOKEN_SECRET or ENCRYPTION_SECRET is required for vault merge tokens");
  }
  return secret;
}

function base64UrlEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function base64UrlDecode(value) {
  return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
}

function signPayload(payload) {
  return crypto.createHmac("sha256", getMergeSecret()).update(payload).digest("base64url");
}

function createMergeToken({ primaryUserUuid, secondaryUserUuid, reason = "link_merge" }) {
  const payload = base64UrlEncode({
    primaryUserUuid: String(primaryUserUuid),
    secondaryUserUuid: String(secondaryUserUuid),
    reason,
    exp: Date.now() + MERGE_TOKEN_TTL_MS,
  });
  return `${payload}.${signPayload(payload)}`;
}

function verifyMergeToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) {
    return { ok: false, reason: "invalid" };
  }

  const expected = signPayload(payload);
  const provided = Buffer.from(signature);
  const actual = Buffer.from(expected);
  if (provided.length !== actual.length || !crypto.timingSafeEqual(provided, actual)) {
    return { ok: false, reason: "invalid" };
  }

  let decoded;
  try {
    decoded = base64UrlDecode(payload);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (!decoded.primaryUserUuid || !decoded.secondaryUserUuid || Number(decoded.exp) <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    primaryUserUuid: decoded.primaryUserUuid,
    secondaryUserUuid: decoded.secondaryUserUuid,
    reason: decoded.reason || "link_merge",
  };
}

async function fetchVaultForMerge(userUuid) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select("user_uuid, telegram_id, username, auth_user_id, email, web_linked_at, vault_pin_hash, encryption_salt")
      .eq("user_uuid", String(userUuid))
      .maybeSingle()
  );

  if (error) throw error;
  return data || null;
}

async function fetchMergeCards(userUuid) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .select("id, user_uuid, telegram_id, brand, amount, code_encrypted, pin_encrypted, expiry_date, is_redeemed, created_at, redeemed_at")
      .eq("user_uuid", String(userUuid))
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
  );

  if (error) throw error;
  return data || [];
}

async function verifyPinForMerge(vault, pin, label) {
  if (!vault) {
    const error = new Error(`${label} vault was not found`);
    error.code = "MERGE_VAULT_NOT_FOUND";
    throw error;
  }

  const ok = await bcrypt.compare(String(pin || ""), vault.vault_pin_hash);
  if (!ok) {
    const error = new Error(`${label} PIN is incorrect`);
    error.code = "MERGE_BAD_PIN";
    error.pinLabel = label;
    throw error;
  }
}

async function decryptCardForMerge(card, vault, pin) {
  const code = await decrypt(card.code_encrypted, pin, vault.encryption_salt);
  const cardPin = card.pin_encrypted ? await decrypt(card.pin_encrypted, pin, vault.encryption_salt) : null;
  return { card, code, cardPin };
}

async function reencryptCardForMerge(card, code, cardPin, primaryVault, finalPin) {
  const codeEncrypted = await encrypt(code, finalPin, primaryVault.encryption_salt);
  const pinEncrypted = cardPin ? await encrypt(cardPin, finalPin, primaryVault.encryption_salt) : null;
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .update({
        user_uuid: primaryVault.user_uuid,
        telegram_id: primaryVault.telegram_id || null,
        code_encrypted: codeEncrypted,
        pin_encrypted: pinEncrypted,
      })
      .eq("id", card.id)
  );

  if (error) throw error;
}

async function updateOwnership(table, fromUserUuid, primaryVault) {
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from(table)
      .update({
        user_uuid: primaryVault.user_uuid,
        telegram_id: primaryVault.telegram_id || null,
      })
      .eq("user_uuid", String(fromUserUuid))
  );

  if (error && error.code !== "42P01") throw error;
}

async function deleteByUserUuid(table, userUuid) {
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from(table)
      .delete()
      .eq("user_uuid", String(userUuid))
  );

  if (error && error.code !== "42P01") throw error;
}

async function deleteMergedDuplicateCard(card) {
  const { error: reminderError } = await withSupabaseRetry(() =>
    supabase
      .from("expiry_reminders_vault")
      .delete()
      .eq("gift_card_id", card.id)
  );
  if (reminderError && reminderError.code !== "42P01") throw reminderError;

  const { error: eventError } = await withSupabaseRetry(() =>
    supabase
      .from("card_events_vault")
      .delete()
      .eq("card_id", card.id)
  );
  if (eventError && eventError.code !== "42P01") throw eventError;

  const { error: cardError } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .delete()
      .eq("id", card.id)
  );
  if (cardError) throw cardError;
}

function buildMergeDedupeKey(brand, code) {
  return `${normalizeBrandKey(brand)}:${String(code || "").trim().toLowerCase()}`;
}

async function mergeVaultsWithPins({ mergeToken, primaryPin, secondaryPin, finalPin, authUserId }) {
  const normalizedPrimaryPin = String(primaryPin || "").trim();
  const normalizedSecondaryPin = String(secondaryPin || "").trim();
  const normalizedFinalPin = String(finalPin || "").trim();

  const verified = verifyMergeToken(mergeToken);
  if (!verified.ok) {
    const error = new Error(verified.reason === "expired" ? "Merge link expired" : "Invalid merge link");
    error.code = "MERGE_TOKEN_INVALID";
    throw error;
  }

  const [primaryVault, secondaryVault] = await Promise.all([
    fetchVaultForMerge(verified.primaryUserUuid),
    fetchVaultForMerge(verified.secondaryUserUuid),
  ]);

  if (!primaryVault || !secondaryVault) {
    const error = new Error("One of the vaults no longer exists");
    error.code = "MERGE_VAULT_NOT_FOUND";
    throw error;
  }

  if (primaryVault.auth_user_id && String(primaryVault.auth_user_id) !== String(authUserId)) {
    const error = new Error("This merge must be completed from the web account linked to the primary vault");
    error.code = "MERGE_FORBIDDEN";
    throw error;
  }

  await verifyPinForMerge(primaryVault, normalizedPrimaryPin, "Web");
  await verifyPinForMerge(secondaryVault, normalizedSecondaryPin, "Telegram");

  let effectiveFinalPin = normalizedFinalPin;
  if (!effectiveFinalPin && normalizedPrimaryPin === normalizedSecondaryPin) {
    effectiveFinalPin = normalizedPrimaryPin;
  }

  if (!effectiveFinalPin) {
    const error = new Error("Choose one PIN for the merged vault");
    error.code = "MERGE_FINAL_PIN_REQUIRED";
    throw error;
  }

  if (!PIN_REGEX.test(effectiveFinalPin)) {
    const error = new Error("Final PIN must be 6 to 20 digits");
    error.code = "MERGE_BAD_FINAL_PIN";
    throw error;
  }

  const [primaryCards, secondaryCards] = await Promise.all([
    fetchMergeCards(primaryVault.user_uuid),
    fetchMergeCards(secondaryVault.user_uuid),
  ]);

  // Merge re-encrypts on the server using the bot's scrypt+AES path, which only
  // knows how to decrypt `server`-mode ciphertext. Client-side ciphertext from
  // the web app (crypto_mode='client') cannot be decrypted server-side without
  // the user's PIN-derived key, which we never receive. Refuse the merge with
  // a recoverable message so no partial-state mutation happens.
  const hasClientCards = [...primaryCards, ...secondaryCards].some(
    (card) => (card.crypto_mode || "server") === "client"
  );
  if (hasClientCards) {
    const error = new Error(
      "One of your accounts holds cards saved from the web app. Open that account on web, export those cards, delete them from that vault, then try the merge again."
    );
    error.code = "MERGE_CLIENT_CARDS_PRESENT";
    throw error;
  }

  const primaryDecrypted = [];
  for (const card of primaryCards) {
    primaryDecrypted.push(await decryptCardForMerge(card, primaryVault, normalizedPrimaryPin));
  }

  const secondaryDecrypted = [];
  for (const card of secondaryCards) {
    secondaryDecrypted.push(await decryptCardForMerge(card, secondaryVault, normalizedSecondaryPin));
  }

  const mergedPrimaryVault = {
    ...primaryVault,
    telegram_id: primaryVault.telegram_id || secondaryVault.telegram_id || null,
  };

  if (
    secondaryVault.telegram_id &&
    (!primaryVault.telegram_id || String(primaryVault.telegram_id) !== String(secondaryVault.telegram_id))
  ) {
    const { error: releaseTelegramError } = await withSupabaseRetry(() =>
      supabase
        .from("users_vault")
        .update({ telegram_id: null, username: null })
        .eq("user_uuid", secondaryVault.user_uuid)
    );
    if (releaseTelegramError) throw releaseTelegramError;
  }

  // Re-encrypt every card under the final PIN FIRST, then swap the vault PIN
  // hash LAST. The hash swap is the single mutation that makes `effectiveFinalPin`
  // the live unlock secret — keeping it last means a crash mid-loop leaves the
  // vault still unlockable with the original PIN and its original ciphertext
  // intact, instead of a hash that no longer matches the un-re-encrypted cards.
  // (Full atomicity across rows would require a Postgres transaction/RPC; this
  // ordering removes the data-loss window for the common same-PIN merge.)
  const seenCards = new Set();
  let duplicateCards = 0;
  for (const { card, code, cardPin } of [...primaryDecrypted, ...secondaryDecrypted]) {
    const dedupeKey = buildMergeDedupeKey(card.brand, code);
    if (seenCards.has(dedupeKey)) {
      await deleteMergedDuplicateCard(card);
      duplicateCards += 1;
      continue;
    }

    seenCards.add(dedupeKey);
    await reencryptCardForMerge(card, code, cardPin, mergedPrimaryVault, effectiveFinalPin);
  }

  const finalHash = await bcrypt.hash(effectiveFinalPin, 12);
  const { error: primaryUpdateError } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .update({
        telegram_id: mergedPrimaryVault.telegram_id,
        username: primaryVault.username || secondaryVault.username || null,
        vault_pin_hash: finalHash,
        failed_attempts: 0,
        locked_until: null,
      })
      .eq("user_uuid", primaryVault.user_uuid)
  );
  if (primaryUpdateError) throw primaryUpdateError;

  await updateOwnership("card_events_vault", primaryVault.user_uuid, mergedPrimaryVault);
  await updateOwnership("expiry_reminders_vault", primaryVault.user_uuid, mergedPrimaryVault);
  await updateOwnership("card_events_vault", secondaryVault.user_uuid, mergedPrimaryVault);
  await updateOwnership("expiry_reminders_vault", secondaryVault.user_uuid, mergedPrimaryVault);

  await deleteByUserUuid("gmail_accounts_vault", secondaryVault.user_uuid);
  await deleteByUserUuid("gmail_oauth_states_vault", secondaryVault.user_uuid);
  await deleteByUserUuid("gmail_processed_messages_vault", secondaryVault.user_uuid);
  await deleteByUserUuid("telegram_link_tokens_vault", primaryVault.user_uuid);
  await deleteByUserUuid("telegram_link_tokens_vault", secondaryVault.user_uuid);

  const { error: secondaryDeleteError } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .delete()
      .eq("user_uuid", secondaryVault.user_uuid)
  );
  if (secondaryDeleteError) throw secondaryDeleteError;

  if (primaryVault.auth_user_id) forgetUserByAuthUserId(primaryVault.auth_user_id);
  if (secondaryVault.auth_user_id) forgetUserByAuthUserId(secondaryVault.auth_user_id);
  if (primaryVault.telegram_id) forgetUserByTelegramId(primaryVault.telegram_id);
  if (secondaryVault.telegram_id) forgetUserByTelegramId(secondaryVault.telegram_id);

  logInfo("Vaults merged", {
    primaryUserUuid: primaryVault.user_uuid,
    secondaryUserUuid: secondaryVault.user_uuid,
    primaryCards: primaryCards.length,
    secondaryCards: secondaryCards.length,
    duplicateCards,
  });

  return {
    userUuid: primaryVault.user_uuid,
    mergedCards: primaryCards.length + secondaryCards.length - duplicateCards,
    primaryCards: primaryCards.length,
    secondaryCards: secondaryCards.length,
    duplicateCards,
  };
}

module.exports = {
  createMergeToken,
  mergeVaultsWithPins,
  verifyMergeToken,
};
