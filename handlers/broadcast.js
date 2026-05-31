const { supabase } = require("../lib/supabase");
const { logError, logInfo } = require("../lib/logger");

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const BROADCAST_BATCH_SIZE = positiveIntegerEnv("BROADCAST_BATCH_SIZE", 20);
const BROADCAST_BATCH_DELAY_MS = positiveIntegerEnv("BROADCAST_BATCH_DELAY_MS", 1000);
const BROADCAST_RETRY_LIMIT = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllTelegramIds() {
  const { data, error } = await supabase
    .from("users_vault")
    .select("telegram_id");

  if (error) {
    throw error;
  }

  return (data || []).map((row) => row.telegram_id);
}

function broadcastSendOptions(options = {}) {
  return options.entities?.length ? { entities: options.entities } : {};
}

function getRetryAfterMs(error) {
  const retryAfter = Number(error?.response?.parameters?.retry_after);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? (retryAfter + 1) * 1000 : null;
}

async function sendBroadcastMessage(bot, telegramId, text, options, attempt = 0) {
  try {
    await bot.sendMessage(telegramId, text, broadcastSendOptions(options));
    return { sent: true };
  } catch (error) {
    const retryAfterMs = getRetryAfterMs(error);
    if (retryAfterMs && attempt < BROADCAST_RETRY_LIMIT) {
      await sleep(retryAfterMs);
      return sendBroadcastMessage(bot, telegramId, text, options, attempt + 1);
    }

    logError("Broadcast send failed", error, { telegramId });
    return { sent: false };
  }
}

async function handleBroadcast(bot, msg, text, options = {}) {
  const adminChatId = msg.chat.id;

  if (!text.trim()) {
    await bot.sendMessage(adminChatId, "Usage: /broadcast <message>");
    return;
  }

  let telegramIds;
  try {
    telegramIds = await fetchAllTelegramIds();
  } catch (error) {
    logError("Broadcast fetch users failed", error);
    await bot.sendMessage(adminChatId, `❌ Failed to fetch users: ${error.message}`);
    return;
  }

  if (!telegramIds.length) {
    await bot.sendMessage(adminChatId, "No users to broadcast to.");
    return;
  }

  await bot.sendMessage(adminChatId, `📢 Broadcasting to ${telegramIds.length} users in batches of ${BROADCAST_BATCH_SIZE}...`);

  let sent = 0;
  let failed = 0;
  const total = telegramIds.length;

  for (let offset = 0; offset < total; offset += BROADCAST_BATCH_SIZE) {
    const batch = telegramIds.slice(offset, offset + BROADCAST_BATCH_SIZE);
    const results = await Promise.all(
      batch.map((telegramId) => sendBroadcastMessage(bot, telegramId, text, options))
    );

    sent += results.filter((result) => result.sent).length;
    failed += results.filter((result) => !result.sent).length;

    const processed = Math.min(offset + batch.length, total);
    if (processed < total) {
      await bot.sendMessage(adminChatId, `⏳ Progress: ${processed}/${total} (${sent} sent, ${failed} failed)`).catch(() => {});
      await sleep(BROADCAST_BATCH_DELAY_MS);
    }
  }

  logInfo("Broadcast completed", { sent, failed, total: telegramIds.length });
  await bot.sendMessage(
    adminChatId,
    `✅ Broadcast complete.\n📨 Sent: ${sent}\n❌ Failed: ${failed}`
  );
}

module.exports = { handleBroadcast };
