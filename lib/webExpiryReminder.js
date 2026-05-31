const cron = require("node-cron");
const webPush = require("web-push");
const { formatDisplayDate } = require("./cardDisplay");
const { logError, logInfo, logWarn } = require("./logger");
const { supabase, withSupabaseRetry } = require("./supabase");

const REMINDER_WINDOW_DAYS = Number(process.env.WEB_EXPIRY_REMINDER_WINDOW_DAYS || 7);
const REMINDER_TIMEZONE = process.env.EXPIRY_REMINDER_TIMEZONE;
const WEB_EXPIRY_REMINDER_CRON = process.env.WEB_EXPIRY_REMINDER_CRON || process.env.EXPIRY_REMINDER_CRON;
const EMAIL_REMINDER_TYPE = "expiry_7d_web_email";
const PUSH_REMINDER_TYPE = "expiry_7d_web_push";

function webPushConfigured() {
  return Boolean(
    process.env.WEB_PUSH_PUBLIC_KEY &&
    process.env.WEB_PUSH_PRIVATE_KEY &&
    process.env.WEB_PUSH_SUBJECT
  );
}

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_FROM);
}

function configureWebPush() {
  if (!webPushConfigured()) return false;
  webPush.setVapidDetails(
    process.env.WEB_PUSH_SUBJECT,
    process.env.WEB_PUSH_PUBLIC_KEY,
    process.env.WEB_PUSH_PRIVATE_KEY
  );
  return true;
}

function formatDateAsIso(date) {
  return date.toISOString().slice(0, 10);
}

function getTimeZoneDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function startOfToday(timeZone = REMINDER_TIMEZONE) {
  const { year, month, day } = getTimeZoneDateParts(new Date(), timeZone);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function buildAlertTitle(cards) {
  return `${cards.length} gift card${cards.length === 1 ? "" : "s"} expiring soon`;
}

function buildPlainTextMessage(cards) {
  const lines = cards.map(
    (card, index) => `${index + 1}. ${card.brand} Rs ${card.amount} - expires ${formatDisplayDate(card.expiry_date)}`
  );
  return [
    buildAlertTitle(cards),
    "",
    "Please redeem them or mark them as redeemed if already used.",
    "",
    ...lines,
  ].join("\n");
}

function buildHtmlMessage(cards) {
  const items = cards
    .map(
      (card) =>
        `<li><strong>${escapeHtml(card.brand)}</strong> Rs ${escapeHtml(card.amount)} - expires ${escapeHtml(formatDisplayDate(card.expiry_date))}</li>`
    )
    .join("");
  return [
    `<p>${escapeHtml(buildAlertTitle(cards))}.</p>`,
    "<p>Please redeem them or mark them as redeemed if already used.</p>",
    `<ol>${items}</ol>`,
  ].join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchUnremindedCards(reminderType) {
  if (!REMINDER_TIMEZONE) {
    throw new Error("EXPIRY_REMINDER_TIMEZONE is required");
  }

  const today = startOfToday(REMINDER_TIMEZONE);
  const todayIso = formatDateAsIso(today);
  const upcomingIso = formatDateAsIso(addDays(today, REMINDER_WINDOW_DAYS));

  const { data: cards, error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .select("id, user_uuid, telegram_id, brand, amount, expiry_date")
      .eq("is_redeemed", false)
      .not("user_uuid", "is", null)
      .not("expiry_date", "is", null)
      .gte("expiry_date", todayIso)
      .lte("expiry_date", upcomingIso)
      .order("user_uuid", { ascending: true })
      .order("expiry_date", { ascending: true })
      .order("id", { ascending: true })
  );

  if (error) throw error;
  const allCards = cards || [];
  if (!allCards.length) return [];

  const { data: reminders, error: remindersError } = await withSupabaseRetry(() =>
    supabase
      .from("expiry_reminders_vault")
      .select("gift_card_id")
      .eq("reminder_type", reminderType)
      .in("gift_card_id", allCards.map((card) => card.id))
  );

  if (remindersError) throw remindersError;
  const remindedCardIds = new Set((reminders || []).map((row) => Number(row.gift_card_id)));
  return allCards.filter((card) => !remindedCardIds.has(Number(card.id)));
}

function groupCardsByUserUuid(cards) {
  const grouped = new Map();
  for (const card of cards) {
    const userUuid = String(card.user_uuid);
    if (!grouped.has(userUuid)) grouped.set(userUuid, []);
    grouped.get(userUuid).push(card);
  }
  return grouped;
}

async function fetchUsers(userUuids) {
  if (!userUuids.length) return new Map();
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select("user_uuid, email")
      .in("user_uuid", userUuids)
  );
  if (error) throw error;
  return new Map((data || []).map((user) => [String(user.user_uuid), user]));
}

async function fetchPushSubscriptions(userUuids) {
  if (!userUuids.length) return new Map();
  const { data, error } = await withSupabaseRetry(() =>
    supabase
      .from("web_push_subscriptions_vault")
      .select("id, user_uuid, endpoint, p256dh, auth")
      .in("user_uuid", userUuids)
      .is("disabled_at", null)
  );
  if (error) throw error;

  const grouped = new Map();
  for (const subscription of data || []) {
    const userUuid = String(subscription.user_uuid);
    if (!grouped.has(userUuid)) grouped.set(userUuid, []);
    grouped.get(userUuid).push(subscription);
  }
  return grouped;
}

async function saveReminderRows(cards, reminderType) {
  if (!cards.length) return;
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("expiry_reminders_vault")
      .upsert(
        cards.map((card) => ({
          gift_card_id: card.id,
          telegram_id: card.telegram_id ? String(card.telegram_id) : null,
          user_uuid: card.user_uuid,
          reminder_type: reminderType,
          notified_at: new Date().toISOString(),
        })),
        { onConflict: "gift_card_id,reminder_type" }
      )
  );
  if (error) throw error;
}

async function sendEmail(to, cards) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.ALERT_EMAIL_FROM,
      to,
      subject: buildAlertTitle(cards),
      text: buildPlainTextMessage(cards),
      html: buildHtmlMessage(cards),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Resend email failed: ${response.status} ${text.slice(0, 200)}`);
  }
}

async function sendPush(subscription, cards) {
  const payload = JSON.stringify({
    title: buildAlertTitle(cards),
    body: cards.slice(0, 3).map((card) => `${card.brand} expires ${formatDisplayDate(card.expiry_date)}`).join("\n"),
    url: process.env.SPACE_APP_URL || "/",
  });

  await webPush.sendNotification({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  }, payload);

  await withSupabaseRetry(() =>
    supabase
      .from("web_push_subscriptions_vault")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", subscription.id)
  );
}

async function disablePushSubscription(subscriptionId) {
  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("web_push_subscriptions_vault")
      .update({ disabled_at: new Date().toISOString() })
      .eq("id", subscriptionId)
  );
  if (error) logWarn("Failed to disable push subscription", { subscriptionId, error: error.message });
}

async function runEmailReminderJob() {
  if (!emailConfigured()) return { notifiedUsers: 0, notifiedCards: 0, skipped: "email_not_configured" };

  const grouped = groupCardsByUserUuid(await fetchUnremindedCards(EMAIL_REMINDER_TYPE));
  const users = await fetchUsers([...grouped.keys()]);
  let notifiedUsers = 0;
  let notifiedCards = 0;

  for (const [userUuid, cards] of grouped.entries()) {
    const email = users.get(userUuid)?.email;
    if (!email) continue;

    try {
      await sendEmail(email, cards);
      await saveReminderRows(cards, EMAIL_REMINDER_TYPE);
      notifiedUsers += 1;
      notifiedCards += cards.length;
    } catch (error) {
      logError("Web expiry email failed", error, { userUuid, cardIds: cards.map((card) => card.id) });
    }
  }

  return { notifiedUsers, notifiedCards };
}

async function runPushReminderJob() {
  if (!configureWebPush()) return { notifiedUsers: 0, notifiedCards: 0, skipped: "push_not_configured" };

  const grouped = groupCardsByUserUuid(await fetchUnremindedCards(PUSH_REMINDER_TYPE));
  const subscriptionsByUser = await fetchPushSubscriptions([...grouped.keys()]);
  let notifiedUsers = 0;
  let notifiedCards = 0;

  for (const [userUuid, cards] of grouped.entries()) {
    const subscriptions = subscriptionsByUser.get(userUuid) || [];
    if (!subscriptions.length) continue;

    let delivered = false;
    for (const subscription of subscriptions) {
      try {
        await sendPush(subscription, cards);
        delivered = true;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await disablePushSubscription(subscription.id);
        }
        logError("Web expiry push failed", error, { userUuid, subscriptionId: subscription.id });
      }
    }

    if (delivered) {
      await saveReminderRows(cards, PUSH_REMINDER_TYPE);
      notifiedUsers += 1;
      notifiedCards += cards.length;
    }
  }

  return { notifiedUsers, notifiedCards };
}

async function runWebExpiryReminderJob() {
  const [emailResult, pushResult] = await Promise.all([runEmailReminderJob(), runPushReminderJob()]);
  logInfo("Web expiry reminder job completed", { email: emailResult, push: pushResult });
  return { email: emailResult, push: pushResult };
}

function startWebExpiryReminderJob() {
  if (!WEB_EXPIRY_REMINDER_CRON) {
    logInfo("Web expiry reminder job not scheduled; WEB_EXPIRY_REMINDER_CRON is unset");
    return null;
  }

  if (!REMINDER_TIMEZONE) {
    throw new Error("EXPIRY_REMINDER_TIMEZONE is required");
  }

  logInfo("Web expiry reminder job scheduled", {
    cron: WEB_EXPIRY_REMINDER_CRON,
    timezone: REMINDER_TIMEZONE,
  });

  return cron.schedule(WEB_EXPIRY_REMINDER_CRON, () => {
    runWebExpiryReminderJob().catch((error) => {
      logError("Web expiry reminder job failed", error);
    });
  }, {
    timezone: REMINDER_TIMEZONE,
  });
}

module.exports = {
  EMAIL_REMINDER_TYPE,
  PUSH_REMINDER_TYPE,
  configureWebPush,
  emailConfigured,
  runWebExpiryReminderJob,
  startWebExpiryReminderJob,
  webPushConfigured,
};
