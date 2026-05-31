require("dotenv").config();

const os = require("os");
const TelegramBot = require("./lib/telegramBot");
const { isAwaitingOnboarding } = require("./handlers/onboarding");
const { handleBroadcast } = require("./handlers/broadcast");
const {
  handleShow,
  handleShowAll,
  handleCallback,
  handleDeleteAccount,
  handleDeleteAll,
  handleSaveCard,
  handleSearch,
  isImageMessage,
  shouldIgnoreMediaGroupMessage,
} = require("./handlers/cards");
const { sendHelp } = require("./handlers/help");
const { handleLinkWeb, sendMovedToWebMessage } = require("./handlers/linkWeb");
const { startExpiryReminderJob } = require("./lib/expiryReminder");
const { setHealthState, startHealthServer } = require("./lib/health");
const { logError, logInfo, logWarn } = require("./lib/logger");
const {
  buildSaveCardPayload,
  endSession,
  getActiveSession,
  handlePendingPin,
  isAwaitingPin,
  unlockSession,
} = require("./handlers/session");
const { checkGeneralLimit } = require("./lib/rateLimit");
const { clearPendingOnboarding, isBlocked, isPermanentlyBlocked, permanentlyBlockUser, permanentlyUnblockUser, pruneRuntimeState, recordViolation } = require("./lib/runtimeStore");
const { track } = require("./lib/analytics");
const { getUserByTelegramId, getVaultCardCountByTelegramId } = require("./lib/vaultUsers");
const { parseCommand, sliceMessageEntities } = require("./lib/commandParser");

const ERROR = "\u274C";
const WARNING = "\u26A0\uFE0F";
const LOCK = "\u{1F512}";
const HEALTH_PORT = process.env.HEALTH_PORT ? Number(process.env.HEALTH_PORT) : null;
const BLOCK_DURATION_HOURS = Number(process.env.BLOCK_DURATION_HOURS) || 1;
const BLOCK_DURATION_LABEL = BLOCK_DURATION_HOURS === 1 ? "1 hour" : `${BLOCK_DURATION_HOURS} hours`;

const requiredEnvVars = [
  "TELEGRAM_BOT_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "EXPIRY_REMINDER_CRON",
  "EXPIRY_REMINDER_TIMEZONE",
];

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`${key} is required`);
  }
}

if (!process.env.ENCRYPTION_SECRET && !process.env.ENCRYPTION_SECRET_V1) {
  throw new Error("ENCRYPTION_SECRET or ENCRYPTION_SECRET_V1 is required");
}

if (process.env.VERTEX_API_KEY && String(process.env.AI_PARSING_ENABLED || "").toLowerCase() !== "true") {
  logWarn("Vertex API key is configured, but AI parsing remains disabled until AI_PARSING_ENABLED=true");
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const GREETING_REGEX = /^(hi|hello|hey|hii|helo|howdy)$/i;
const healthServer = startHealthServer(HEALTH_PORT);
const expiryReminderJob = startExpiryReminderJob(bot);

setHealthState({ telegramPolling: true });
bot.on("polling_error", (error) => {
  logError("Telegram polling error", error);
  setHealthState({ lastErrorAt: new Date().toISOString() });
});
setInterval(() => {
  pruneRuntimeState().catch((error) => {
    logError("Runtime state prune failed", error);
    setHealthState({ lastErrorAt: new Date().toISOString() });
  });
}, 5 * 60 * 1000).unref();

async function withErrorReply(botInstance, chatId, work) {
  try {
    await work();
  } catch (error) {
    logError("Unhandled bot error", error, { chatId });
    setHealthState({ lastErrorAt: new Date().toISOString() });
    await botInstance.sendMessage(chatId, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
}

function isSaveCandidateMessage(msg) {
  return Boolean(isImageMessage(msg) || (msg.text && !msg.text.trim().startsWith("/")));
}

function isPrivateChat(chat) {
  return chat?.type === "private";
}

function isWebLinkedVault(user) {
  return Boolean(user?.auth_user_id || user?.web_linked_at);
}

bot.on("message", async (msg) => {
  if (!msg.from || !msg.chat) {
    return;
  }

  const telegramId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const { command, args, rawArgs, rawArgsOffset } = parseCommand(msg.text || "");

  if (shouldIgnoreMediaGroupMessage(msg)) {
    return;
  }

  await withErrorReply(bot, chatId, async () => {
    if (!isPrivateChat(msg.chat)) {
      if (command === "/start" || command === "/help" || command === "/show" || command === "/show_all" || command === "/search" || command === "/delete_all" || command === "/delete_account" || command === "/end" || command === "/link_web" || isSaveCandidateMessage(msg)) {
        await bot.sendMessage(chatId, `${WARNING} For privacy, use this bot only in a private chat\\.`, {
          parse_mode: "MarkdownV2",
        });
      }
      return;
    }

    if (command === "/broadcast" || command === "/block" || command === "/unblock") {
      if (process.env.ADMIN_TELEGRAM_ID && telegramId === process.env.ADMIN_TELEGRAM_ID) {
        if (command === "/broadcast") {
          await handleBroadcast(bot, msg, rawArgs, {
            entities: sliceMessageEntities(msg.entities, rawArgsOffset, rawArgs.length),
          });
        } else if (command === "/block") {
          const [targetId, ...reasonParts] = args.trim().split(/\s+/);
          if (!targetId || !/^\d+$/.test(targetId)) {
            await bot.sendMessage(chatId, "Usage: /block <telegram_id> [reason]\ntelegram_id must be numeric.");
            return;
          }
          const reason = reasonParts.length ? reasonParts.join(" ") : null;
          await permanentlyBlockUser(targetId, reason);
          logInfo("Admin blocked user", { adminId: telegramId, targetId, reason });
          const reasonNote = reason ? ` Reason: ${reason}` : "";
          await bot.sendMessage(chatId, `✅ User ${targetId} permanently blocked.${reasonNote}`);
        } else if (command === "/unblock") {
          const targetId = args.trim();
          if (!targetId || !/^\d+$/.test(targetId)) {
            await bot.sendMessage(chatId, "Usage: /unblock <telegram_id>\ntelegram_id must be numeric.");
            return;
          }
          await permanentlyUnblockUser(targetId);
          logInfo("Admin unblocked user", { adminId: telegramId, targetId });
          await bot.sendMessage(chatId, `✅ User ${targetId} unblocked.`);
        }
      }
      // Silently ignore for all other users — command existence is not revealed
      return;
    }

    if (await isBlocked(telegramId) || await isPermanentlyBlocked(telegramId)) {
      return;
    }

    if (command === "/end") {
      await endSession(telegramId);
      await bot.sendMessage(chatId, `${LOCK} Session ended\\. Type /start to begin again\\.`, {
        parse_mode: "MarkdownV2",
      });
      return;
    }

    const generalLimit = await checkGeneralLimit(telegramId);
    if (!generalLimit.allowed) {
      const justBlocked = await recordViolation(telegramId);
      track("error.rate_limit", telegramId, { limit_type: "general", blocked: justBlocked });
      if (justBlocked) {
        await bot.sendMessage(chatId, `${WARNING} You have been blocked for ${BLOCK_DURATION_LABEL} due to repeated abuse\\.`, { parse_mode: "MarkdownV2" });
        return;
      }
      await bot.sendMessage(
        chatId,
        `${WARNING} Too many messages\\. Please wait ${generalLimit.retryAfter} seconds\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    if (await isAwaitingOnboarding(telegramId)) {
      await clearPendingOnboarding(telegramId);
      await sendMovedToWebMessage(bot, chatId);
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await sendMovedToWebMessage(bot, chatId);
      return;
    }

    if (isWebLinkedVault(user)) {
      await sendMovedToWebMessage(bot, chatId);
      return;
    }

    const cardCount = await getVaultCardCountByTelegramId(telegramId);
    if (cardCount === 0) {
      await sendMovedToWebMessage(bot, chatId);
      return;
    }

    if (await isAwaitingPin(telegramId)) {
      if (!msg.text) {
        await bot.sendMessage(chatId, `${ERROR} Enter your vault PIN to continue\\.`, {
          parse_mode: "MarkdownV2",
        });
        return;
      }

      await handlePendingPin(bot, msg, {
        handleShow,
        handleShowAll,
        handleDeleteAccount,
        handleDeleteAll,
        handleSaveCard,
        handleSearch,
        sendHelp,
      });
      return;
    }

    const session = await getActiveSession(telegramId);

    if (session && session.chatId && String(session.chatId) !== String(chatId)) {
      await bot.sendMessage(chatId, `${WARNING} Your active vault session is bound to a different chat\\. Use /end there or continue in that original private chat\\.`, {
        parse_mode: "MarkdownV2",
      });
      return;
    }

    if (command === "/start" || GREETING_REGEX.test(text)) {
      if (session) {
        await sendHelp(bot, chatId);
        return;
      }

      await unlockSession(bot, msg, { type: "help", payload: {} });
      return;
    }

    if (command === "/help") {
      await sendHelp(bot, chatId);
      return;
    }

    if (command === "/link_web") {
      await handleLinkWeb(bot, msg);
      return;
    }

    if (command === "/show" || command === "/cards") {
      if (session) {
        await handleShow(bot, msg, session);
        return;
      }

      await unlockSession(bot, msg, { type: "show", payload: {} });
      return;
    }

    if (command === "/show_all") {
      if (session) {
        await handleShowAll(bot, msg, session);
        return;
      }

      await unlockSession(bot, msg, { type: "show_all", payload: {} });
      return;
    }

    if (command === "/search") {
      if (session) {
        await handleSearch(bot, msg, session, args);
        return;
      }

      await unlockSession(bot, msg, {
        type: "search",
        payload: { query: args },
      });
      return;
    }

    if (command === "/delete_all") {
      if (session) {
        await handleDeleteAll(bot, msg, session);
        return;
      }

      await unlockSession(bot, msg, {
        type: "delete_all",
        payload: {},
      });
      return;
    }

    if (command === "/delete_account") {
      if (session) {
        await handleDeleteAccount(bot, msg, session);
        return;
      }

      await unlockSession(bot, msg, {
        type: "delete_account",
        payload: {},
      });
      return;
    }

    if (isSaveCandidateMessage(msg)) {
      if (session) {
        // Already unlocked — parse and save the card
        await handleSaveCard(bot, msg, session);
        return;
      }

      await unlockSession(bot, msg, {
        type: "save_card",
        payload: buildSaveCardPayload(msg),
      });
      return;
    }

    await sendHelp(bot, chatId);
  });
});

bot.on("callback_query", async (callbackQuery) => {
  if (!callbackQuery.from || !callbackQuery.message) {
    return;
  }

  const telegramId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;

  try {
    if (!isPrivateChat(callbackQuery.message.chat)) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "Use this bot in a private chat for sensitive actions.",
      });
      return;
    }

    if (await isBlocked(telegramId) || await isPermanentlyBlocked(telegramId)) {
      await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      return;
    }

    const generalLimit = await checkGeneralLimit(telegramId);
    if (!generalLimit.allowed) {
      const justBlocked = await recordViolation(telegramId);
      if (justBlocked) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: `${WARNING} Blocked for ${BLOCK_DURATION_LABEL} due to repeated abuse.` });
        return;
      }
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `${WARNING} Too many messages. Wait ${generalLimit.retryAfter} seconds.`,
      });
      return;
    }

    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} User not found` });
      return;
    }

    if (isWebLinkedVault(user)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: "Use Space web for this vault." });
      await sendMovedToWebMessage(bot, chatId);
      return;
    }

    const cardCount = await getVaultCardCountByTelegramId(telegramId);
    if (cardCount === 0) {
      await bot.answerCallbackQuery(callbackQuery.id);
      await sendMovedToWebMessage(bot, chatId);
      return;
    }

    const session = await getActiveSession(telegramId);
    if (!session) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `${LOCK} Session expired. Send any message to unlock.`,
      });
      return;
    }

    if (session.chatId && String(session.chatId) !== String(chatId)) {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "Continue in the original private chat where you unlocked your vault.",
      });
      return;
    }

    await handleCallback(bot, callbackQuery, session);
  } catch (error) {
    logError("Callback route error", error, { telegramId, chatId });
    setHealthState({ lastErrorAt: new Date().toISOString() });
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: `${ERROR} Something went wrong. Please try again.`,
    });
    await bot.sendMessage(chatId, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
});

async function shutdown(signal) {
  setHealthState({ shuttingDown: true, telegramPolling: false });
  logWarn("Shutdown requested", { signal });

  const forceExitTimer = setTimeout(() => {
    logError("Graceful shutdown timed out after 15s, forcing exit");
    process.exit(1);
  }, 15000);

  try {
    await bot.stopPolling();
  } catch (error) {
    logError("Failed to stop Telegram polling", error, { signal });
  }

  try {
    expiryReminderJob.stop();
  } catch (error) {
    logError("Failed to stop expiry reminder job", error, { signal });
  }

  if (healthServer) {
    await new Promise((resolve) => healthServer.close(resolve));
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection", reason instanceof Error ? reason : new Error(String(reason)));
  setHealthState({ lastErrorAt: new Date().toISOString() });
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", error);
  setHealthState({ lastErrorAt: new Date().toISOString() });
  process.exit(1);
});

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    logError("SIGINT shutdown failed", error);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    logError("SIGTERM shutdown failed", error);
    process.exit(1);
  });
});

track("system.startup", null);
logInfo("CKSpace bot is running", {
  healthPort: HEALTH_PORT || null,
  host: os.hostname(),
  nodeVersion: process.version,
});
