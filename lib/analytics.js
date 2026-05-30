const crypto = require("crypto");
const { supabase } = require("./supabase");
const { logError, logInfo } = require("./logger");

// Only these events are persisted to the database for dashboard queries.
// Everything else is logged to stdout only (standard process logging).
const PERSISTENT_EVENTS = new Set([
  "user.registered",
  "user.login",
  "expiry.reminder_sent",
  "card.saved",
  "card.parse.image",
  "card.parse.text",
  "error.handler",
]);

function hashUserId(telegramId) {
  return crypto.createHash("sha256").update(String(telegramId)).digest("hex");
}

function track(eventType, telegramId, properties = {}) {
  const userHash = telegramId ? hashUserId(String(telegramId)) : null;

  // Always emit to console — captured by your cloud provider's log streaming
  logInfo("analytics", { event: eventType, userHash, ...properties });

  if (!PERSISTENT_EVENTS.has(eventType)) {
    return;
  }

  // Fire-and-forget — never awaited, never blocks user responses
  supabase
    .from("analytics_events_vault")
    .insert({
      event_type: eventType,
      user_hash: userHash,
      properties: Object.keys(properties).length ? properties : null,
    })
    .then(({ error }) => {
      if (error) {
        logError("Analytics write failed", error, { eventType });
      }
    })
    .catch((err) => {
      logError("Analytics track error", err, { eventType });
    });
}

module.exports = {
  hashUserId,
  track,
};
