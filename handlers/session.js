const { logError } = require("../lib/logger");
const {
  clearPendingAction,
  clearSessionPin,
  getPendingAction,
  hydrateSessionPin,
  savePendingAction,
} = require("../lib/runtimeStore");
const { escMd } = require("../lib/markdown");
const { track } = require("../lib/analytics");
const { getVaultAuthByTelegramId, SESSION_MS, verifyVaultPin } = require("../lib/vaultSessions");

const ERROR = "\u274C";
const LOCK = "\u{1F512}";
const UNLOCK = "\u{1F510}";
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

  if (msg.document && typeof msg.document.mime_type === "string" && msg.document.mime_type.startsWith("image/")) {
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
  await savePendingAction(telegramId, msg.chat.id, pendingAction.type, pendingAction.payload);

  await bot.sendMessage(
    msg.chat.id,
    `${UNLOCK} Enter your vault PIN to unlock Space\\.`,
    { parse_mode: "MarkdownV2" }
  );
}

async function resumePendingAction(bot, msg, session, pendingAction, handlers) {
  if (!pendingAction) {
    await bot.sendMessage(msg.chat.id, `${ERROR} No pending action found\\. Try again\\.`, {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  if (pendingAction.action_type === "help") {
    await handlers.sendHelp(bot, msg.chat.id);
    return;
  }

  if (pendingAction.action_type === "cards" || pendingAction.action_type === "show") {
    await handlers.handleShow(bot, msg, session);
    return;
  }

  if (pendingAction.action_type === "show_all") {
    await handlers.handleShowAll(bot, msg, session);
    return;
  }

  if (pendingAction.action_type === "search") {
    await handlers.handleSearch(bot, msg, session, pendingAction.payload?.query || "");
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
      text: pendingAction.payload?.kind === "text" ? pendingAction.payload.text || "" : undefined,
      photo: pendingAction.payload?.kind === "photo" ? pendingAction.payload.photo || [] : undefined,
      document: pendingAction.payload?.kind === "document" ? pendingAction.payload.document || null : undefined,
      caption: pendingAction.payload?.caption || "",
      media_group_id: pendingAction.payload?.mediaGroupId || undefined,
    };

    await handlers.handleSaveCard(bot, replayedMessage, session);
    return;
  }

  await bot.sendMessage(msg.chat.id, `${ERROR} Unsupported pending action\\. Try again\\.`, {
    parse_mode: "MarkdownV2",
  });
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
        { parse_mode: "MarkdownV2" }
      );
      return true;
    }

    const user = await getVaultAuthByTelegramId(telegramId);
    if (!user) {
      await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
        parse_mode: "MarkdownV2",
      });
      return true;
    }

    const verification = await verifyVaultPin(user, pin, { trackUserId: telegramId });

    if (verification.status === "locked") {
      await bot.sendMessage(
        msg.chat.id,
        `${LOCK} Too many wrong attempts\\. Try after ${escMd(verification.retryAfterMinutes)} minutes\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return true;
    }

    if (!verification.ok) {
        // Freshly crossed a multiple of MAX_FAILED_ATTEMPTS — start a new lockout.
      await bot.sendMessage(
        msg.chat.id,
        `${ERROR} Wrong PIN\\. ${escMd(verification.attemptsRemaining || 0)} attempts remaining\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return true;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_MS);
    const encryptionSalt = verification.encryptionSalt;
    activeSessions.set(telegramId, {
      vaultPin: pin,
      encryptionSalt,
      expiresAt,
      chatId: String(msg.chat.id),
    });
    track("user.login", telegramId);

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
      handlers
    );
    return true;
  } catch (error) {
    logError("Session handler error", error, { telegramId });
    await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
    return true;
  }
}

async function unlockSession(bot, msg, pendingAction) {
  try {
    await promptForPin(bot, msg, pendingAction);
  } catch (error) {
    logError("Unlock session error", error, { telegramId: String(msg.from?.id) });
    await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
}

function startSessionForUser(telegramId, { vaultPin, encryptionSalt, chatId }) {
  const key = String(telegramId);
  activeSessions.set(key, {
    vaultPin,
    encryptionSalt: String(encryptionSalt),
    expiresAt: new Date(Date.now() + SESSION_MS),
    chatId: String(chatId),
  });
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
  startSessionForUser,
  unlockSession,
};
