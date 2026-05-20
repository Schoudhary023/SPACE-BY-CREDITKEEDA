const { createClient } = require("@supabase/supabase-js");
const { logWarn } = require("./logger");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

// Force IPv4 to avoid potential IPv6 issues
process.env.NODE_OPTIONS =
  (process.env.NODE_OPTIONS || "") + " --dns-result-order=ipv4first";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  global: {
    headers: {
      "x-my-custom-header": "ckspace-bot",
    },
  },
  db: {
    schema: "public",
  },
});

function isTransientError(error) {
  if (!error) return false;
  const message = String(error.message || error).toLowerCase();
  const code = String(error.code || "").toLowerCase();
  const status = Number(error.status || error.statusCode || error.status_code);

  return (
    code === "econnreset" ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("econnrefused") ||
    message.includes("connect") ||
    message.includes("bad gateway") ||
    message.includes("service unavailable") ||
    message.includes("gateway timeout") ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function withSupabaseRetry(fn, retries = 3, baseDelay = 200) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === retries) {
        throw error;
      }

      const delayMs = baseDelay * Math.pow(2, attempt - 1);
      logWarn(
        `Supabase transient error (attempt ${attempt}/${retries}), retrying in ${delayMs}ms`,
        { error: error.message },
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

module.exports = {
  supabase,
  withSupabaseRetry,
};
