const bcrypt = require("bcryptjs");
const { logError } = require("../lib/logger");
const {
  clearPendingAction,
  clearSessionPin,
  getPendingAction,
  hydrateSessionPin,
  savePendingAction,
} = require("../lib/runtimeStore");
const { supabase, withSupabaseRetry } = require("../lib/supabase");
const { escMd } = require("../lib/markdown");
const { track } = require("../lib/analytics");

const ERROR = "\u274C";
const LOCK = "\u{1F512}";
const UNLOCK = "\u{1F510}";
const SESSION_MS = 30 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 3;

// Escalating lockout: each cycle of MAX_FAILED_ATTEMPTS increases duration.
// totalAttempts accumulates across lockouts (only reset on success).
function getLockoutDuration(totalAttempts) {
  if (totalAttempts >= 12) return 24 * 60 * 60 * 1000; // 24 h
  if (totalAttempts >= 9) return 4 * 60 * 60 * 1000; // 4 h
  if (totalAttempts >= 6) return 60 * 60 * 1000; // 1 h
  return 30 * 60 * 1000; // 30 min (first lockout)
}
const activeSessions = new Map();

function cleanupExpiredActiveSessions() {
  const now = Date.now();

  for (const [telegramId, session] of activeSessions.entries()) {
    if (session.expiresAt.getTime() <= now) {
      activeSessions.delete(telegramId);
    }
  }
}

setInterval(cleanupExpiredActiveSessions, 5 * 60 * 1000).unref();

// Returns { vaultPin, encryptionSalt } for an active session, or null.
// encryptionSalt is the platform-agnostic UUID from users_vault — used as
// the KDF salt so decryption works from any platform (Telegram, web, app).
async function getActiveSession(telegramId) {
  const key = String(telegramId);
  const session = activeSessions.get(key);

  if (session && session.expiresAt.getTime() > Date.now()) {
    return {
      vaultPin: session.vaultPin,
      encryptionSalt: session.encryptionSalt,
      chatId: session.chatId,
    };
  }

  if (session) {
    activeSessions.delete(key);
  }

  const hydrated = await hydrateSessionPin(key);
  if (!hydrated) {
    return null;
  }

  activeSessions.set(key, hydrated);
  return {
    vaultPin: hydrated.vaultPin,
    encryptionSalt: hydrated.encryptionSalt,
    chatId: hydrated.chatId,
  };
}

async function getActiveSessionPin(telegramId) {
  const session = await getActiveSession(telegramId);
  return session?.vaultPin ?? null;
}

async function isSessionActive(telegramId) {
  return Boolean(await getActiveSessionPin(telegramId));
}

async function isAwaitingPin(telegramId) {
  return Boolean(await getPendingAction(telegramId));
}

function buildSaveCardPayload(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    return {
      kind: "photo",
      photo: msg.photo,
      caption: msg.caption || "",
      mediaGroupId: msg.media_group_id || null,
    };
  }

  if (
    msg.document &&
    typeof msg.document.mime_type === "string" &&
    msg.document.mime_type.startsWith("image/")
  ) {
    return {
      kind: "document",
      document: msg.document,
      caption: msg.caption || "",
      mediaGroupId: msg.media_group_id || null,
    };
  }

  return {
    kind: "text",
    text: msg.text || "",
  };
}

async function promptForPin(bot, msg, pendingAction) {
  const telegramId = String(msg.from.id);
  await savePendingAction(
    telegramId,
    msg.chat.id,
    pendingAction.type,
    pendingAction.payload,
  );

  await bot.sendMessage(
    msg.chat.id,
    `${UNLOCK} Enter your vault PIN to unlock Space\\.`,
    { parse_mode: "MarkdownV2" },
  );
}

async function resumePendingAction(bot, msg, session, pendingAction, handlers) {
  if (!pendingAction) {
    await bot.sendMessage(
      msg.chat.id,
      `${ERROR} No pending action found\\. Try again\\.`,
      {
        parse_mode: "MarkdownV2",
      },
    );
    return;
  }

  if (pendingAction.action_type === "help") {
    await handlers.sendHelp(bot, msg.chat.id);
    return;
  }

  if (
    pendingAction.action_type === "cards" ||
    pendingAction.action_type === "show"
  ) {
    await handlers.handleShow(bot, msg, session);
    return;
  }

  if (pendingAction.action_type === "show_all") {
    await handlers.handleShowAll(bot, msg, session);
    return;
  }

  if (pendingAction.action_type === "search") {
    await handlers.handleSearch(
      bot,
      msg,
      session,
      pendingAction.payload?.query || "",
    );
    return;
  }

  if (pendingAction.action_type === "delete_all") {
    await handlers.handleDeleteAll(bot, msg, session);
    return;
  }

  if (pendingAction.action_type === "delete_account") {
    await handlers.handleDeleteAccount(bot, msg, session);
    return;
  }

  if (pendingAction.action_type === "save_card") {
    const replayedMessage = {
      ...msg,
      text:
        pendingAction.payload?.kind === "text"
          ? pendingAction.payload.text || ""
          : undefined,
      photo:
        pendingAction.payload?.kind === "photo"
          ? pendingAction.payload.photo || []
          : undefined,
      document:
        pendingAction.payload?.kind === "document"
          ? pendingAction.payload.document || null
          : undefined,
      caption: pendingAction.payload?.caption || "",
      media_group_id: pendingAction.payload?.mediaGroupId || undefined,
    };

    await handlers.handleSaveCard(bot, replayedMessage, session);
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `${ERROR} Unsupported pending action\\. Try again\\.`,
    {
      parse_mode: "MarkdownV2",
    },
  );
}

async function handlePendingPin(bot, msg, handlers) {
  const telegramId = String(msg.from.id);
  const pendingAction = await getPendingAction(telegramId);

  if (!pendingAction || !msg.text) {
    return false;
  }

  const pin = msg.text.trim();

  try {
    if (String(pendingAction.chat_id) !== String(msg.chat.id)) {
      await bot.sendMessage(
        msg.chat.id,
        `${ERROR} For privacy, return to the original chat where you started this action and enter your PIN there\\.`,
        { parse_mode: "MarkdownV2" },
      );
      return true;
    }

    const { data: user, error } = await withSupabaseRetry(() =>
      supabase
        .from("users_vault")
        .select(
          "telegram_id, vault_pin_hash, failed_attempts, locked_until, encryption_salt",
        )
        .eq("telegram_id", telegramId)
        .maybeSingle(),
    );

    if (error) {
      throw error;
    }

    if (!user) {
      await bot.sendMessage(
        msg.chat.id,
        `${ERROR} Something went wrong\\. Please try again\\.`,
        {
          parse_mode: "MarkdownV2",
        },
      );
      return true;
    }

    const now = new Date();
    if (user.locked_until && new Date(user.locked_until) > now) {
      const minutes = Math.max(
        1,
        Math.ceil(
          (new Date(user.locked_until).getTime() - now.getTime()) / 60000,
        ),
      );
      await bot.sendMessage(
        msg.chat.id,
        `${LOCK} Too many wrong attempts\\. Try after ${escMd(minutes)} minutes\\.`,
        { parse_mode: "MarkdownV2" },
      );
      return true;
    }

    const isValidPin = await bcrypt.compare(pin, user.vault_pin_hash);

    if (!isValidPin) {
      const nextAttempts = (user.failed_attempts ?? 0) + 1;
      // Remaining tries in the current cycle (resets every MAX_FAILED_ATTEMPTS).
      const remainder = nextAttempts % MAX_FAILED_ATTEMPTS;
      const attemptsRemaining =
        remainder === 0 ? 0 : MAX_FAILED_ATTEMPTS - remainder;
      const updatePayload = { failed_attempts: nextAttempts };

      if (remainder === 0) {
        // Freshly crossed a multiple of MAX_FAILED_ATTEMPTS — start a new lockout.
        // failed_attempts is left accumulating so getLockoutDuration escalates each cycle.
        const lockoutMs = getLockoutDuration(nextAttempts);
        updatePayload.locked_until = new Date(
          now.getTime() + lockoutMs,
        ).toISOString();
        track("user.locked_out", telegramId, {
          lockout_minutes: Math.round(lockoutMs / 60000),
        });
      }

      const { error: updateError } = await withSupabaseRetry(() =>
        supabase
          .from("users_vault")
          .update(updatePayload)
          .eq("telegram_id", telegramId),
      );

      if (updateError) {
        throw updateError;
      }

      track("user.login_failed", telegramId, { attempt: nextAttempts });
      await bot.sendMessage(
        msg.chat.id,
        `${ERROR} Wrong PIN\\. ${escMd(attemptsRemaining)} attempts remaining\\.`,
        { parse_mode: "MarkdownV2" },
      );
      return true;
    }

    const expiresAt = new Date(now.getTime() + SESSION_MS);
    const encryptionSalt = String(user.encryption_salt);
    activeSessions.set(telegramId, {
      vaultPin: pin,
      encryptionSalt,
      expiresAt,
      chatId: String(msg.chat.id),
    });
    track("user.login", telegramId);

    const { error: resetError } = await withSupabaseRetry(() =>
      supabase
        .from("users_vault")
        .update({ failed_attempts: 0, locked_until: null })
        .eq("telegram_id", telegramId),
    );

    if (resetError) {
      throw resetError;
    }

    // Intentionally NOT persisting the vault PIN to the database.
    // The PIN lives only in the in-memory activeSessions map for the duration
    // of the session. On server restart users must re-enter their PIN.
    // This prevents a compromised database from exposing active vault PINs.
    await clearPendingAction(telegramId);
    await resumePendingAction(
      bot,
      msg,
      { vaultPin: pin, encryptionSalt, chatId: String(msg.chat.id) },
      pendingAction,
      handlers,
    );
    return true;
  } catch (error) {
    logError("Session handler error", error, { telegramId });
    await bot.sendMessage(
      msg.chat.id,
      `${ERROR} Something went wrong\\. Please try again\\.`,
      {
        parse_mode: "MarkdownV2",
      },
    );
    return true;
  }
}

async function unlockSession(bot, msg, pendingAction) {
  try {
    await promptForPin(bot, msg, pendingAction);
  } catch (error) {
    logError("Unlock session error", error, {
      telegramId: String(msg.from?.id),
    });
    await bot.sendMessage(
      msg.chat.id,
      `${ERROR} Something went wrong\\. Please try again\\.`,
      {
        parse_mode: "MarkdownV2",
      },
    );
  }
}

async function endSession(telegramId) {
  const key = String(telegramId);
  track("user.session_ended", key);
  activeSessions.delete(key);
  await clearPendingAction(key);
  await clearSessionPin(key);
}

module.exports = {
  buildSaveCardPayload,
  endSession,
  getActiveSession,
  getActiveSessionPin,
  handlePendingPin,
  isAwaitingPin,
  isSessionActive,
  unlockSession,
};
