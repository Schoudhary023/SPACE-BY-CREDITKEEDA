const crypto = require("crypto");
const { supabase, withSupabaseRetry } = require("./supabase");

const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

async function createLinkToken(userUuid, direction) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString();

  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("telegram_link_tokens_vault")
      .insert({ token, user_uuid: String(userUuid), direction, expires_at: expiresAt })
  );

  if (error) throw error;
  return { token, expiresAt };
}

async function verifyLinkToken(token, direction) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("telegram_link_tokens_vault")
      .select("token, user_uuid, expires_at, used_at")
      .eq("token", String(token || ""))
      .eq("direction", direction)
      .maybeSingle()
  );

  if (error) throw error;
  if (!data) return { ok: false, reason: "not_found" };
  if (data.used_at) return { ok: false, reason: "already_used" };
  if (new Date(data.expires_at) <= new Date()) return { ok: false, reason: "expired" };

  return { ok: true, userUuid: data.user_uuid };
}

async function getLinkTokenRecord(token, direction) {
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("telegram_link_tokens_vault")
      .select("token, user_uuid, expires_at, used_at")
      .eq("token", String(token || ""))
      .eq("direction", direction)
      .maybeSingle()
  );

  if (error) throw error;
  return data || null;
}

async function consumeLinkToken(token) {
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("telegram_link_tokens_vault")
      .update({ used_at: new Date().toISOString() })
      .eq("token", String(token || ""))
  );

  if (error) throw error;
}

module.exports = { createLinkToken, verifyLinkToken, getLinkTokenRecord, consumeLinkToken };
