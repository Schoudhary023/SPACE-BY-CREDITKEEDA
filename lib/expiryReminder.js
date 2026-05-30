const cron = require("node-cron");
const { logError, logInfo } = require("./logger");
const { escMd } = require("./markdown");
const { formatDisplayDate } = require("./cardDisplay");
const { supabase, withSupabaseRetry } = require("./supabase");
const { track } = require("./analytics");

const WARNING = "\u26A0\uFE0F";
const RUPEE = "\u20B9";
const EXPIRY_REMINDER_CRON = process.env.EXPIRY_REMINDER_CRON;
const EXPIRY_REMINDER_TIMEZONE = process.env.EXPIRY_REMINDER_TIMEZONE;
const REMINDER_WINDOW_DAYS = 7;
const REMINDER_TYPE = "expiry_7d";

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
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function startOfToday(timeZone = EXPIRY_REMINDER_TIMEZONE) {
  const { year, month, day } = getTimeZoneDateParts(new Date(), timeZone);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function buildReminderMessage(cards) {
  const intro = [
    `${WARNING} ${escMd(cards.length)} gift card${cards.length === 1 ? "" : "s"} ${cards.length === 1 ? "is" : "are"} nearing expiry\\.`,
    "If not redeemed, they may expire soon\\.",
    "Please redeem them or mark them as redeemed if already used\\.",
    "",
  ];

  const lines = cards.map((card, index) =>
    `${escMd(index + 1)}\\. ${escMd(card.brand)} ${RUPEE}${escMd(card.amount)} \\- expires ${escMd(formatDisplayDate(card.expiry_date))}`
  );

  const outro = [
    "",
    "Use /show to view active cards or /search \\<brand\\> to find a specific card\\.",
  ];

  return [...intro, ...lines, ...outro].join("\n");
}

async function fetchExpiringCards() {
  if (!EXPIRY_REMINDER_TIMEZONE) {
    throw new Error("EXPIRY_REMINDER_TIMEZONE is required");
  }

  const today = startOfToday(EXPIRY_REMINDER_TIMEZONE);
  const todayIso = formatDateAsIso(today);
  const upcomingIso = formatDateAsIso(addDays(today, REMINDER_WINDOW_DAYS));

  const { data: cards, error } = await withSupabaseRetry(() =>
    supabase
      .from("gift_cards_vault")
      .select("id, telegram_id, user_uuid, brand, amount, expiry_date")
      .eq("is_redeemed", false)
      .eq("crypto_mode", "server")
      .not("telegram_id", "is", null)
      .not("expiry_date", "is", null)
      .gte("expiry_date", todayIso)
      .lte("expiry_date", upcomingIso)
      .order("telegram_id", { ascending: true })
      .order("expiry_date", { ascending: true })
      .order("id", { ascending: true })
  );

  if (error) {
    throw error;
  }

  const allCards = cards || [];

  if (!allCards.length) {
    return [];
  }

  const { data: reminders, error: remindersError } = await withSupabaseRetry(() =>
    supabase
      .from("expiry_reminders_vault")
      .select("gift_card_id")
      .eq("reminder_type", REMINDER_TYPE)
      .in("gift_card_id", allCards.map((card) => card.id))
  );

  if (remindersError) {
    throw remindersError;
  }

  const remindedCardIds = new Set((reminders || []).map((row) => Number(row.gift_card_id)));
  const pendingCards = allCards.filter((card) => !remindedCardIds.has(Number(card.id)));

  if (!pendingCards.length) {
    return [];
  }

  const telegramIds = [...new Set(pendingCards.map((card) => String(card.telegram_id)))];
  const { data: users, error: usersError } = await withSupabaseRetry(() =>
    supabase
      .from("users_vault")
      .select("telegram_id, auth_user_id, web_linked_at")
      .in("telegram_id", telegramIds)
  );

  if (usersError) {
    throw usersError;
  }

  const webLinkedTelegramIds = new Set(
    (users || [])
      .filter((user) => user.auth_user_id || user.web_linked_at)
      .map((user) => String(user.telegram_id))
  );

  return pendingCards.filter((card) => !webLinkedTelegramIds.has(String(card.telegram_id)));
}

function groupCardsByTelegramId(cards) {
  const grouped = new Map();

  for (const card of cards) {
    const telegramId = String(card.telegram_id);

    if (!grouped.has(telegramId)) {
      grouped.set(telegramId, []);
    }

    grouped.get(telegramId).push(card);
  }

  return grouped;
}

async function saveReminderRows(cards) {
  if (!cards.length) {
    return;
  }

  const { error } = await withSupabaseRetry(() =>
    supabase
      .from("expiry_reminders_vault")
      .upsert(
        cards.map((card) => ({
          gift_card_id: card.id,
          telegram_id: String(card.telegram_id),
          reminder_type: REMINDER_TYPE,
          notified_at: new Date().toISOString(),
        })),
        { onConflict: "gift_card_id,reminder_type" }
      )
  );

  if (error) {
    throw error;
  }
}

async function runExpiryReminderJob(bot) {
  const cards = await fetchExpiringCards();

  if (!cards.length) {
    logInfo("Expiry reminder job completed", { notifiedUsers: 0, notifiedCards: 0 });
    return;
  }

  const grouped = groupCardsByTelegramId(cards);
  let notifiedUsers = 0;
  let notifiedCards = 0;

  for (const [telegramId, userCards] of grouped.entries()) {
    try {
      await bot.sendMessage(Number(telegramId), buildReminderMessage(userCards), {
        parse_mode: "MarkdownV2",
      });

      await saveReminderRows(userCards);
      track("expiry.reminder_sent", telegramId, { card_count: userCards.length });
      notifiedUsers += 1;
      notifiedCards += userCards.length;
    } catch (error) {
      logError("Expiry reminder send failed", error, {
        telegramId,
        cardIds: userCards.map((card) => card.id),
      });
    }
  }

  logInfo("Expiry reminder job completed", { notifiedUsers, notifiedCards });
}

function startExpiryReminderJob(bot) {
  if (!EXPIRY_REMINDER_CRON) {
    throw new Error("EXPIRY_REMINDER_CRON is required");
  }

  if (!EXPIRY_REMINDER_TIMEZONE) {
    throw new Error("EXPIRY_REMINDER_TIMEZONE is required");
  }

  logInfo("Expiry reminder job scheduled", {
    cron: EXPIRY_REMINDER_CRON,
    timezone: EXPIRY_REMINDER_TIMEZONE,
  });

  return cron.schedule(EXPIRY_REMINDER_CRON, () => {
    runExpiryReminderJob(bot).catch((error) => {
      logError("Expiry reminder job failed", error);
    });
  }, {
    timezone: EXPIRY_REMINDER_TIMEZONE,
  });
}

module.exports = {
  runExpiryReminderJob,
  startExpiryReminderJob,
};
