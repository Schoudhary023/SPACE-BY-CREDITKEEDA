const { logWarn } = require("./logger");
const { supabase, withSupabaseRetry } = require("./supabase");

const FEATURES = Object.freeze({
  GMAIL_SYNC: "gmail_sync",
});

function isMissingFeatureFlagTable(error) {
  return error && error.code === "42P01";
}

async function isFeatureEnabledForUser(userUuid, feature) {
  if (!userUuid || !feature) {
    return false;
  }

  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("web_feature_flags_vault")
      .select("enabled")
      .eq("user_uuid", String(userUuid))
      .eq("feature", String(feature))
      .maybeSingle()
  );

  if (error) {
    if (isMissingFeatureFlagTable(error)) {
      logWarn("Feature flags table is missing; feature disabled", { feature, userUuid });
      return false;
    }
    throw error;
  }

  return Boolean(data?.enabled);
}

module.exports = {
  FEATURES,
  isFeatureEnabledForUser,
};
