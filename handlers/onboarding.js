const bcrypt = require("bcryptjs");
const { logError } = require("../lib/logger");
const {
  clearPendingOnboarding,
  getPendingOnboarding,
  savePendingOnboarding,
} = require("../lib/runtimeStore");
const { supabase, withSupabaseRetry } = require("../lib/supabase");
const { sendHelp } = require("./help");
const { track } = require("../lib/analytics");

const ERROR = "\u274C";
const SUCCESS = "\u2705";
const LOCK = "\u{1F510}";
const MAX_ATTEMPTS = 3;
const PIN_REGEX = /^\d{6,20}$/;

async function isAwaitingOnboarding(telegramId) {
  return Boolean(await getPendingOnboarding(telegramId));
}

async function startOnboarding(bot, msg, telegramId) {
  // Store only the pending onboarding state; the PIN is collected in the next
  // message and is never persisted in plaintext.
  await savePendingOnboarding(telegramId, msg.chat.id, 0);

  const welcome = [
    `${LOCK} *Welcome to Space by @creditkeeda\\!*`,
    "Space stores your gift cards securely and encrypts them with your vault PIN\\.",
    "Send a numeric PIN \\(6–20 digits\\) to create your vault\\.",
  ].join("\n\n");

  await bot.sendMessage(msg.chat.id, welcome, { parse_mode: "MarkdownV2" });
}

async function completeOnboarding(bot, msg, telegramId, state) {
  const pin = msg.text.trim();

  if (!PIN_REGEX.test(pin)) {
    const nextAttempts = (state.attempts || 0) + 1;

    if (nextAttempts >= MAX_ATTEMPTS) {
      await clearPendingOnboarding(telegramId);
      await bot.sendMessage(
        msg.chat.id,
        `${ERROR} PIN setup cancelled\\. Send /start to try again\\.`,
        {
          parse_mode: "MarkdownV2",
        },
      );
      return;
    }

    await savePendingOnboarding(telegramId, msg.chat.id, nextAttempts);
    await bot.sendMessage(
      msg.chat.id,
      `${ERROR} PIN must be 6 to 20 digits\\. Try again\\.`,
      {
        parse_mode: "MarkdownV2",
      },
    );
    return;
  }

  const username = msg.from.username ? `@${msg.from.username}` : null;
  // The vault PIN is used for encryption at unlock time. The database stores
  // only this bcrypt hash for verification.
  const pinHash = await bcrypt.hash(pin, 12);
  const { error } = await withSupabaseRetry(() =>
    supabase.from("users_vault").insert({
      telegram_id: telegramId,
      username,
      vault_pin_hash: pinHash,
    }),
  );

  if (error) {
    logError("Supabase onboarding insert error", error, { telegramId });
    await bot.sendMessage(
      msg.chat.id,
      `${ERROR} Failed to create vault\\. Please try again later\\.`,
      {
        parse_mode: "MarkdownV2",
      },
    );
    return;
  }

  await clearPendingOnboarding(telegramId);
  track("user.registered", telegramId);
  await bot.sendMessage(
    msg.chat.id,
    `${SUCCESS} Vault created\\! Your PIN protects your gift cards\\.`,
    { parse_mode: "MarkdownV2" },
  );
  await sendHelp(bot, msg.chat.id);
}

async function handleOnboarding(bot, msg) {
  const telegramId = String(msg.from.id);

  try {
    const state = await getPendingOnboarding(telegramId);

    if (!state) {
      const { data, error } = await withSupabaseRetry(() =>
        supabase
          .from("users_vault")
          .select("telegram_id")
          .eq("telegram_id", telegramId)
          .maybeSingle(),
      );

      if (error) {
        logError("Supabase onboarding lookup error", error, { telegramId });
        await bot.sendMessage(
          msg.chat.id,
          `${ERROR} Database connection issue\\. Please try again later\\.`,
          {
            parse_mode: "MarkdownV2",
          },
        );
        return;
      }

      if (data) {
        return;
      }

      await startOnboarding(bot, msg, telegramId);
      return;
    }

    if (!msg.text) {
      return;
    }

    await completeOnboarding(bot, msg, telegramId, state);
  } catch (error) {
    logError("Onboarding handler error", error, { telegramId });
    await bot.sendMessage(
      msg.chat.id,
      `${ERROR} Something went wrong\\. Please try again\\.`,
      {
        parse_mode: "MarkdownV2",
      },
    );
  }
}

module.exports = {
  handleOnboarding,
  isAwaitingOnboarding,
};
