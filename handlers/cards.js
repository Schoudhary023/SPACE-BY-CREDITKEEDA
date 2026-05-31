const { extractGiftCardsFromImage, extractGiftCardFromText, isAiParsingEnabled } = require("../lib/aiParser");
const { parseCardInput, parseMissingCardDetailsInput, sanitizeParsedCard, sanitizeParsedCards } = require("../lib/cardParser");
const { logError, logInfo, logWarn } = require("../lib/logger");
const { checkCardsLimit, checkImageSaveLimit, checkSaveLimit } = require("../lib/rateLimit");
const { supabase, withSupabaseRetry } = require("../lib/supabase");
const { escMd } = require("../lib/markdown");
const { buildCardKeyboard, buildListIntro, cardMessage, deleteAccountConfirmationMessage, deleteAllConfirmationMessage, deleteConfirmationMessage, formatDisplayDate, getBrandEmoji, saveConfirmationMessage } = require("../lib/cardDisplay");
const { endSession } = require("./session");
const { clearPendingOnboarding, clearUserRateLimits } = require("../lib/runtimeStore");
const { track } = require("../lib/analytics");
const { ERROR, FOLDER, IMAGE_MIME_PREFIX, MEDIA_GROUP_TTL_MS, RUPEE, SUCCESS, TRASH, WARNING } = require("../lib/cardConstants");
const {
  decryptCardSecrets,
  deleteAccountData,
  deleteAllCardsData,
  deleteSingleCardData,
  fetchCardById,
  fetchCards,
  findDuplicateCard,
  logCardEvent,
  saveCard,
} = require("../lib/vaultCards");
const { forgetUserByTelegramId } = require("../lib/vaultUsers");
const seenMediaGroups = new Map();
const renderedListStates = new Map();
const pendingDeleteConfirmations = new Map();
const pendingSaveConfirmations = new Map();
const pendingDetailRequests = new Map();

const CONFIRMATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PAGE_SIZE = 10;
const WEB_ONLY_NOTICE = "Some cards were upgraded for Space web privacy and can only be viewed in Space web.";

function cleanupSeenMediaGroups() {
  const now = Date.now();

  for (const [mediaGroupId, expiresAt] of seenMediaGroups.entries()) {
    if (expiresAt <= now) {
      seenMediaGroups.delete(mediaGroupId);
    }
  }
}

function splitBotReadableCards(cards) {
  const botCards = [];
  const webOnlyCards = [];

  for (const card of cards || []) {
    if ((card.crypto_mode || "server") === "client") {
      webOnlyCards.push(card);
    } else {
      botCards.push(card);
    }
  }

  return { botCards, webOnlyCards };
}

async function sendWebOnlyNotice(bot, chatId, count) {
  if (!count) return;
  await bot.sendMessage(
    chatId,
    `${WARNING} ${escMd(count)} card${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} web\\-only now\\.\n${escMd(WEB_ONLY_NOTICE)}`,
    { parse_mode: "MarkdownV2" }
  );
}

function cleanupExpiredMapEntries() {
  const now = Date.now();

  for (const [key, entry] of renderedListStates.entries()) {
    if (entry._expiresAt && entry._expiresAt <= now) renderedListStates.delete(key);
  }

  for (const [key, entry] of pendingSaveConfirmations.entries()) {
    if (entry._expiresAt && entry._expiresAt <= now) pendingSaveConfirmations.delete(key);
  }

  for (const [key, entry] of pendingDetailRequests.entries()) {
    if (entry._expiresAt && entry._expiresAt <= now) pendingDetailRequests.delete(key);
  }

  for (const [key, entry] of pendingDeleteConfirmations.entries()) {
    if (entry._expiresAt && entry._expiresAt <= now) pendingDeleteConfirmations.delete(key);
  }
}

setInterval(cleanupSeenMediaGroups, 5 * 60 * 1000).unref();
setInterval(cleanupExpiredMapEntries, 5 * 60 * 1000).unref();

function getTelegramIdFromMessageLike(payload) {
  return String(payload.from.id);
}

function isImageMessage(msg) {
  return Boolean(
    (Array.isArray(msg.photo) && msg.photo.length) ||
      (msg.document && typeof msg.document.mime_type === "string" && msg.document.mime_type.startsWith(IMAGE_MIME_PREFIX))
  );
}

function isMultiImageSubmission(msg) {
  return Boolean(msg.media_group_id && isImageMessage(msg));
}

function shouldIgnoreMediaGroupMessage(msg) {
  if (!isImageMessage(msg) || !msg.media_group_id) {
    return false;
  }

  const mediaGroupId = String(msg.media_group_id);
  const now = Date.now();
  const expiresAt = seenMediaGroups.get(mediaGroupId);

  if (expiresAt && expiresAt > now) {
    return true;
  }

  seenMediaGroups.set(mediaGroupId, now + MEDIA_GROUP_TTL_MS);
  return false;
}

function getPendingDeleteKey(telegramId, cardId) {
  return `${telegramId}:${cardId}`;
}

function getEmptyStateMessage(listState) {
  if (listState?.searchTerm) {
    return `${FOLDER} No cards matched *${escMd(listState.searchTerm)}*\\. Try /show to see all cards\\.`;
  }

  if (listState?.includeRedeemed) {
    return `${FOLDER} No gift cards saved yet\\. Send a card image or text to get started\\.`;
  }

  return `${FOLDER} No active gift cards\\. Send a card image or use /show\\_all to include redeemed cards\\.`;
}

function getRenderedListKey(telegramId, chatId) {
  return `${telegramId}:${chatId}`;
}

function getRenderedListState(telegramId, chatId) {
  return renderedListStates.get(getRenderedListKey(telegramId, chatId)) || null;
}

function setRenderedListState(telegramId, chatId, state) {
  renderedListStates.set(getRenderedListKey(telegramId, chatId), { ...state, _expiresAt: Date.now() + CONFIRMATION_TTL_MS });
}

async function deleteMessages(bot, chatId, messageIds = []) {
  for (const messageId of messageIds) {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      logWarn("Failed to delete rendered message", { chatId, messageId, error: error.message });
    }
  }
}

async function clearRenderedListState(bot, telegramId, chatId) {
  const state = getRenderedListState(telegramId, chatId);
  if (!state) {
    return;
  }

  await deleteMessages(bot, chatId, state.messageIds || []);
  renderedListStates.delete(getRenderedListKey(telegramId, chatId));
}

function getPendingSaveKey(telegramId, chatId) {
  return `${telegramId}:${chatId}`;
}

function getPendingDetailKey(telegramId, chatId) {
  return `${telegramId}:${chatId}`;
}

function buildPlainTextFallbackMessage() {
  return [
    `${WARNING} Could not read that card\\.`,
    "Please send it as plain text using this format\\:",
    "`Brand Amount Code [PIN] [Expiry]`",
    "Example\\: `Amazon 1000 ABCD1234 5678 2026\\-10\\-10`",
    "Plain text is the most reliable format\\.",
  ].join("\n");
}

function normalizeGiftCardCode(code) {
  return String(code || "").trim();
}

function getMissingDetails(card) {
  return {
    needsAmount: !Number.isFinite(Number(card.amount)) || Number(card.amount) <= 0,
    needsExpiry: !card.expiryDate && !card._expirySkipped,
  };
}

function findMissingDetailsIndex(cards) {
  return cards.findIndex((card) => {
    const details = getMissingDetails(card);
    return details.needsAmount || details.needsExpiry;
  });
}

function buildMissingDetailsRequestMessage(card, index, total) {
  const { needsAmount, needsExpiry } = getMissingDetails(card);
  const prefix = total > 1 ? `card ${index + 1} of ${total}` : "this card";
  const missingLabel = needsAmount && needsExpiry
    ? "amount and expiry are not visible"
    : needsAmount
      ? "amount is not visible"
      : "expiry is not visible";
  const lines = [
    `${WARNING} I found ${prefix}, but ${missingLabel}.`,
    `Brand: ${card.brand}`,
    `Code: ${card.code}`,
    "",
  ];

  if (needsAmount && needsExpiry) {
    lines.push(
      "Reply with:",
      "Amount Expiry",
      "",
      "Examples:",
      "1000 2026-12-31",
      "1000 31/12/2026",
      "1000 31 Dec 2026",
      "1000 skip"
    );
  } else if (needsAmount) {
    lines.push("Reply with the amount only, for example 1000 or 500.");
  } else {
    lines.push(
      "Reply with an expiry date, or type skip.",
      "",
      "Examples:",
      "2026-12-31",
      "31/12/2026",
      "31 Dec 2026",
      "skip"
    );
  }

  return lines.join("\n");
}

async function requestMissingDetails(bot, chatId, telegramId, parsedCards, parseMode) {
  const missingIndex = findMissingDetailsIndex(parsedCards);
  if (missingIndex === -1) {
    return false;
  }

  const pendingDetailKey = getPendingDetailKey(telegramId, chatId);
  pendingDetailRequests.set(pendingDetailKey, {
    parsedCards,
    parseMode,
    _expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  });

  await bot.sendMessage(
    chatId,
    buildMissingDetailsRequestMessage(parsedCards[missingIndex], missingIndex, parsedCards.length)
  );
  return true;
}

function isVertexFallbackError(error) {
  return [
    "VERTEX_UNAVAILABLE",
    "VERTEX_AUTH_ERROR",
    "VERTEX_BILLING_DISABLED",
    "VERTEX_MODEL_NOT_FOUND",
    "VERTEX_API_ERROR",
    "VERTEX_INVALID_RESPONSE",
  ].includes(error?.code);
}

const IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PREFERRED_PHOTO_MIN_DIMENSION = 1280;
const PROCESSING_CHAT_ACTION_INTERVAL_MS = 4000;
const PROCESSING_MESSAGE_MIN_VISIBLE_MS = 1500;

async function startProcessingIndicator(bot, chatId, text) {
  let messageId = null;
  const startedAt = Date.now();

  const sendAction = () => {
    bot.sendChatAction(chatId, "typing").catch(err => logWarn("sendChatAction failed", { error: err.message }));
  };

  sendAction();
  const interval = setInterval(sendAction, PROCESSING_CHAT_ACTION_INTERVAL_MS);
  interval.unref();

  try {
    const sent = await bot.sendMessage(chatId, text);
    messageId = sent.message_id;
  } catch (err) {
    logWarn("Failed to send processing indicator", { chatId, error: err.message });
  }

  return {
    async stop() {
      clearInterval(interval);

      const visibleMs = Date.now() - startedAt;
      const remainingMs = PROCESSING_MESSAGE_MIN_VISIBLE_MS - visibleMs;
      if (messageId && remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }

      if (messageId) {
        await bot.deleteMessage(chatId, messageId).catch(err => logWarn("Failed to delete processing indicator", { chatId, error: err.message }));
      }
    },
  };
}

function pickPreferredTelegramPhoto(photos) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return null;
  }

  const withDimensions = photos.filter((photo) => Number(photo.width) > 0 && Number(photo.height) > 0);
  if (!withDimensions.length) {
    return photos[photos.length - 1];
  }

  const preferred = [...withDimensions].reverse().find((photo) =>
    Math.max(Number(photo.width), Number(photo.height)) >= PREFERRED_PHOTO_MIN_DIMENSION
  );

  return preferred || withDimensions[withDimensions.length - 1];
}

async function downloadTelegramImagePayload(bot, msg) {
  const photo = pickPreferredTelegramPhoto(msg.photo);
  const document = msg.document && msg.document.mime_type?.startsWith(IMAGE_MIME_PREFIX) ? msg.document : null;
  const fileId = photo?.file_id || document?.file_id;

  if (!fileId) {
    throw new Error("No supported image file found");
  }

  const startedAt = Date.now();
  const fileUrl = await bot.getFileLink(fileId);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(fileUrl, { signal: controller.signal });

    if (!response.ok) {
      throw new Error("Failed to download Telegram image");
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > IMAGE_MAX_BYTES) {
      throw new Error("Image too large to process");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > IMAGE_MAX_BYTES) {
      throw new Error("Image too large to process");
    }

    return {
      imageBase64: Buffer.from(arrayBuffer).toString("base64"),
      mimeType: document?.mime_type || "image/jpeg",
      bytes: arrayBuffer.byteLength,
      width: Number(photo?.width) || null,
      height: Number(photo?.height) || null,
      source: document ? "document" : "photo",
      downloadMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseCardsFromImage(bot, msg, telegramId) {
  if (!isAiParsingEnabled()) {
    track("card.parse.image", telegramId, {
      mode: "failed",
      card_count: 0,
    });

    return { cards: [], mode: "failed" };
  }

  const imagePayload = await downloadTelegramImagePayload(bot, msg);
  const vertexStartedAt = Date.now();
  const raw = await extractGiftCardsFromImage({
    ...imagePayload,
    caption: msg.caption || "",
  });
  const vertexCards = sanitizeParsedCards(raw, { minConfidence: 0.6, requireAmount: false });

  logInfo("Image parse Vertex completed", {
    telegramId,
    cardCount: vertexCards.length,
    source: imagePayload.source,
    width: imagePayload.width,
    height: imagePayload.height,
    bytes: imagePayload.bytes,
    downloadMs: imagePayload.downloadMs,
    vertexMs: Date.now() - vertexStartedAt,
  });

  track("card.parse.image", telegramId, {
    mode: vertexCards.length > 0 ? "vertex" : "failed",
    card_count: vertexCards.length,
  });

  return {
    cards: vertexCards,
    mode: vertexCards.length > 0 ? "vertex" : "failed",
  };
}

async function parseCardFromText(msg, telegramId) {
  const text = msg.text || "";
  const basicParsed = parseCardInput(text);
  if (basicParsed) {
    track("card.parse.text", telegramId, { mode: "local", success: true });
    return { card: basicParsed, mode: "local" };
  }

  if (isAiParsingEnabled()) {
    const vertexRaw = await extractGiftCardFromText(text);
    const vertexCard = sanitizeParsedCard(vertexRaw, { minConfidence: 0.6 });
    track("card.parse.text", telegramId, {
      mode: vertexCard ? "vertex" : "vertex_miss",
      success: Boolean(vertexCard),
      confidence: typeof vertexRaw?.confidence === "number" ? vertexRaw.confidence : null,
      has_brand: Boolean(vertexRaw?.brand),
      has_amount: Number.isFinite(Number(vertexRaw?.amount)),
      has_code: Boolean(String(vertexRaw?.code || "").trim()),
    });
    if (vertexCard) {
      return {
        card: vertexCard,
        mode: "vertex",
      };
    }

    logInfo("Vertex text parse miss", {
      telegramId,
      confidence: typeof vertexRaw?.confidence === "number" ? vertexRaw.confidence : null,
      hasBrand: Boolean(vertexRaw?.brand),
      hasAmount: Number.isFinite(Number(vertexRaw?.amount)),
      hasCode: Boolean(String(vertexRaw?.code || "").trim()),
      notes: vertexRaw?.notes || null,
    });
    track("card.parse.text", telegramId, { mode: "failed", success: false, reason: "vertex_miss" });
    return { card: null, mode: "failed" };
  }

  track("card.parse.text", telegramId, { mode: "failed", success: false, reason: "ai_disabled_or_unconfigured" });
  return { card: null, mode: "failed" };
}

async function sendCards(bot, chatId, telegramId, vaultPin, encryptionSalt, cards, { showMoreRow } = {}) {
  if (!cards.length) {
    return { cards, sent: false, messageIds: [], lastCardBaseRows: null };
  }

  // Decrypt all cards in parallel
  const decryptResults = await Promise.allSettled(
    cards.map(card => decryptCardSecrets(card, vaultPin, encryptionSalt).then(secrets => ({ card, ...secrets })))
  );

  const failedIndex = decryptResults.findIndex(r => r.status === "rejected");
  if (failedIndex !== -1) {
    logError("Card decryption error", decryptResults[failedIndex].reason, { telegramId, cardId: cards[failedIndex].id });
    await bot.sendMessage(chatId, `${ERROR} Could not decrypt\\. Make sure you entered the correct vault PIN\\.`, {
      parse_mode: "MarkdownV2",
    });
    return { cards, sent: false, lastCardBaseRows: null };
  }

  const decryptedCards = decryptResults.map(r => r.value);

  // Send sequentially to preserve order (decrypt was parallel above)
  const messageIds = [];
  let lastCardBaseRows = null;
  for (let i = 0; i < decryptedCards.length; i++) {
    const { card, decryptedCode, decryptedPin } = decryptedCards[i];
    const baseRows = buildCardKeyboard(card, decryptedCode, decryptedPin);
    const isLast = i === decryptedCards.length - 1;
    if (isLast) lastCardBaseRows = baseRows;
    const rows = (isLast && showMoreRow) ? [...baseRows, showMoreRow] : baseRows;
    const sent = await bot.sendMessage(chatId, cardMessage(card, i + 1, decryptedCode, decryptedPin), {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: rows },
    });
    messageIds.push(sent.message_id);
  }

  return { cards, sent: true, messageIds, lastCardBaseRows };
}

function isMessageNotModifiedError(error) {
  return String(error?.message || "").toLowerCase().includes("message is not modified");
}

function buildShowMoreRow(shown, total) {
  const remaining = total - shown;
  if (remaining <= 0) return null;
  return [{ text: `Show more (${remaining})`, callback_data: "show_more" }];
}

async function sendCardListFresh(bot, chatId, telegramId, vaultPin, encryptionSalt, allCards, { includeRedeemed, searchTerm }) {
  const { botCards, webOnlyCards } = splitBotReadableCards(allCards);
  const visibleCards = botCards.slice(0, PAGE_SIZE);
  const messageIds = [];

  await sendWebOnlyNotice(bot, chatId, webOnlyCards.length);

  if (visibleCards.length) {
    const intro = await bot.sendMessage(chatId, buildListIntro(visibleCards, { includeRedeemed, searchTerm, showing: visibleCards.length, total: botCards.length }), {
      parse_mode: "MarkdownV2",
    });
    messageIds.push(intro.message_id);
  }

  const showMoreRow = buildShowMoreRow(visibleCards.length, botCards.length);
  const result = await sendCards(bot, chatId, telegramId, vaultPin, encryptionSalt, visibleCards, { showMoreRow });
  if (Array.isArray(result.messageIds) && result.messageIds.length > 0) {
    messageIds.push(...result.messageIds);
  }

  const showMoreMsgId = showMoreRow ? result.messageIds[result.messageIds.length - 1] : null;
  setRenderedListState(telegramId, chatId, { includeRedeemed, searchTerm, messageIds, allCards: botCards, offset: visibleCards.length, showMoreMsgId, lastCardBaseRows: result.lastCardBaseRows });
  return { ...result, cards: visibleCards };
}

// Edit the existing rendered card list in-place rather than deleting and re-sending.
// existingState.messageIds layout: [introMsgId, card1MsgId, card2MsgId, ...]
// - Edits intro and each card message at their original position.
// - Deletes extra messages when card count decreases.
// - Sends new messages when card count increases.
// Falls back to a fresh render if intro editing fails (e.g. message too old).
async function editCardListInPlace(bot, chatId, telegramId, vaultPin, encryptionSalt, allCards, existingState, { includeRedeemed, searchTerm }) {
  // Always reset to first page on refresh (after delete/redeem)
  const { botCards, webOnlyCards } = splitBotReadableCards(allCards);
  await sendWebOnlyNotice(bot, chatId, webOnlyCards.length);

  const visibleCards = botCards.slice(0, PAGE_SIZE);
  const existingMessageIds = existingState.messageIds;
  const introMessageId = existingMessageIds[0];
  const existingCardMessageIds = existingMessageIds.slice(1);
  const decryptResults = await Promise.allSettled(
    visibleCards.map(card => decryptCardSecrets(card, vaultPin, encryptionSalt).then(s => ({ card, ...s })))
  );

  const failedIndex = decryptResults.findIndex(r => r.status === "rejected");
  if (failedIndex !== -1) {
    logError("Card decryption error during in-place edit", decryptResults[failedIndex].reason, { telegramId, cardId: visibleCards[failedIndex].id });
    await bot.sendMessage(chatId, `${ERROR} Could not decrypt\\. Make sure you entered the correct vault PIN\\.`, {
      parse_mode: "MarkdownV2",
    });
    return { cards: visibleCards, sent: false, messageIds: [] };
  }

  const decryptedCards = decryptResults.map(r => r.value);

  const newMessageIds = [];

  try {
    await bot.editMessageText(buildListIntro(visibleCards, { includeRedeemed, searchTerm, showing: visibleCards.length, total: botCards.length }), {
      chat_id: chatId,
      message_id: introMessageId,
      parse_mode: "MarkdownV2",
    });
    newMessageIds.push(introMessageId);
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      newMessageIds.push(introMessageId);
    } else {
      logWarn("Edit-in-place intro failed, falling back to fresh render", { chatId, error: error.message });
      await clearRenderedListState(bot, telegramId, chatId);
      return sendCardListFresh(bot, chatId, telegramId, vaultPin, encryptionSalt, allCards, { includeRedeemed, searchTerm });
    }
  }

  // Edit existing messages in parallel (fixed positions — no ordering concern).
  // New sends (fallback or card count increase) are collected and sent sequentially after.
  const pendingNewSends = [];
  const editResults = await Promise.all(
    decryptedCards.map(async ({ card, decryptedCode, decryptedPin }, i) => {
      const existingMsgId = existingCardMessageIds[i];
      if (existingMsgId) {
        try {
          await bot.editMessageText(cardMessage(card, i + 1, decryptedCode, decryptedPin), {
            chat_id: chatId,
            message_id: existingMsgId,
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: buildCardKeyboard(card, decryptedCode, decryptedPin) },
          });
          return { i, msgId: existingMsgId };
        } catch (error) {
          if (isMessageNotModifiedError(error)) {
            return { i, msgId: existingMsgId };
          }
          logWarn("Failed to edit card message in-place, will send new", { chatId, messageId: existingMsgId, error: error.message });
          pendingNewSends.push({ i, card, decryptedCode, decryptedPin, staleId: existingMsgId });
          return { i, msgId: null };
        }
      } else {
        pendingNewSends.push({ i, card, decryptedCode, decryptedPin, staleId: null });
        return { i, msgId: null };
      }
    })
  );

  // Build msgId array from edits, then fill in new sends sequentially (preserves order)
  const msgIdMap = new Map(editResults.map(r => [r.i, r.msgId]));
  for (const { i, card, decryptedCode, decryptedPin, staleId } of pendingNewSends.sort((a, b) => a.i - b.i)) {
    const sent = await bot.sendMessage(chatId, cardMessage(card, i + 1, decryptedCode, decryptedPin), {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: buildCardKeyboard(card, decryptedCode, decryptedPin) },
    });
    msgIdMap.set(i, sent.message_id);
    if (staleId) {
      bot.deleteMessage(chatId, staleId).catch(err => logWarn("Failed to delete stale card message", { chatId, messageId: staleId, error: err.message }));
    }
  }

  for (let i = 0; i < decryptedCards.length; i++) {
    newMessageIds.push(msgIdMap.get(i));
  }

  // Delete extra old messages when visible card count decreased
  await deleteMessages(bot, chatId, existingCardMessageIds.slice(visibleCards.length));

  // Add/remove show_more button on the last card
  const showMoreRow = buildShowMoreRow(visibleCards.length, botCards.length);
  const lastDecrypted = decryptedCards[decryptedCards.length - 1];
  const lastCardBaseRows = lastDecrypted ? buildCardKeyboard(lastDecrypted.card, lastDecrypted.decryptedCode, lastDecrypted.decryptedPin) : null;
  const lastCardMsgId = lastDecrypted ? newMessageIds[newMessageIds.length - 1] : null;
  const showMoreMsgId = showMoreRow ? lastCardMsgId : null;
  if (showMoreRow && lastCardBaseRows && lastCardMsgId) {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [...lastCardBaseRows, showMoreRow] },
      { chat_id: chatId, message_id: lastCardMsgId }
    ).catch(err => {
      if (!isMessageNotModifiedError(err)) {
        logWarn("Failed to add show_more to last card", { chatId, error: err.message });
      }
    });
  }

  setRenderedListState(telegramId, chatId, { includeRedeemed, searchTerm, messageIds: newMessageIds, allCards: botCards, offset: visibleCards.length, showMoreMsgId, lastCardBaseRows });
  return { cards: visibleCards, sent: true, messageIds: newMessageIds };
}

async function sendCardList(bot, chatId, telegramId, vaultPin, encryptionSalt, { includeRedeemed = false, searchTerm = null, forceRefresh = false, prefetchedCards = null } = {}) {
  const existingState = getRenderedListState(telegramId, chatId);
  const allCards = prefetchedCards ?? await fetchCards(telegramId, { includeRedeemed, searchTerm });
  const { botCards, webOnlyCards } = splitBotReadableCards(allCards);

  if (botCards.length === 0 && webOnlyCards.length > 0) {
    await clearRenderedListState(bot, telegramId, chatId);
    await sendWebOnlyNotice(bot, chatId, webOnlyCards.length);
    return { cards: [], sent: false, messageIds: [] };
  }

  if (!forceRefresh && existingState?.messageIds?.length > 0 && botCards.length > 0) {
    return editCardListInPlace(bot, chatId, telegramId, vaultPin, encryptionSalt, allCards, existingState, { includeRedeemed, searchTerm });
  }

  await clearRenderedListState(bot, telegramId, chatId);
  return sendCardListFresh(bot, chatId, telegramId, vaultPin, encryptionSalt, allCards, { includeRedeemed, searchTerm });
}

async function doSaveCard(bot, chatId, telegramId, vaultPin, encryptionSalt, parsed, source = "text") {
  const amount = Number(parsed.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    await bot.sendMessage(chatId, `${WARNING} Amount is required before saving this gift card\\.`, {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  try {
    await saveCard(telegramId, vaultPin, encryptionSalt, parsed, source);
  } catch (error) {
    logError("Supabase save card error", error, { telegramId });
    await bot.sendMessage(chatId, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  await bot.sendMessage(
    chatId,
    `${SUCCESS} ${escMd(parsed.brand)} gift card saved\\! Amount: ${RUPEE}${escMd(amount)}${parsed.expiryDate ? ` \\| Expires: ${escMd(formatDisplayDate(parsed.expiryDate))}` : ""}${parsed.pin ? "" : " \\| No PIN saved"}`,
    { parse_mode: "MarkdownV2" }
  );
}

async function sendSaveConfirmation(bot, chatId, telegramId, parsedCards, parseMode) {
  const pendingSaveKey = getPendingSaveKey(telegramId, chatId);
  const existingPending = pendingSaveConfirmations.get(pendingSaveKey);
  if (existingPending?.promptMessageId) {
    try {
      await bot.deleteMessage(existingPending.chatId, existingPending.promptMessageId);
    } catch (_) {}
  }

  const confirmation = saveConfirmationMessage(parsedCards);
  const sentMsg = await bot.sendMessage(chatId, confirmation.text, {
    parse_mode: "MarkdownV2",
    reply_markup: confirmation.reply_markup,
  });
  pendingSaveConfirmations.set(pendingSaveKey, {
    parsedCards,
    parseMode,
    chatId,
    promptMessageId: sentMsg.message_id,
    _expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  });
}

async function handlePendingDetailsResponse(bot, msg, telegramId) {
  if (!msg.text || msg.text.trim().startsWith("/")) {
    return false;
  }

  const pendingDetailKey = getPendingDetailKey(telegramId, msg.chat.id);
  const pendingDetails = pendingDetailRequests.get(pendingDetailKey);
  if (!pendingDetails) {
    return false;
  }

  const missingIndex = findMissingDetailsIndex(pendingDetails.parsedCards);
  if (missingIndex === -1) {
    pendingDetailRequests.delete(pendingDetailKey);
    return false;
  }

  const currentCard = pendingDetails.parsedCards[missingIndex];
  const missingDetails = getMissingDetails(currentCard);
  const parsedDetails = parseMissingCardDetailsInput(msg.text, missingDetails);
  if (!parsedDetails) {
    await bot.sendMessage(
      msg.chat.id,
      `${WARNING} I could not read that. Please follow the example format, or type skip for expiry.`
    );
    return true;
  }

  pendingDetails.parsedCards[missingIndex] = {
    ...currentCard,
    amount: parsedDetails.amount ?? currentCard.amount,
    expiryDate: parsedDetails.expiryDate ?? currentCard.expiryDate,
    _expirySkipped: parsedDetails.skippedExpiry || currentCard._expirySkipped || false,
  };

  const nextMissingIndex = findMissingDetailsIndex(pendingDetails.parsedCards);
  if (nextMissingIndex !== -1) {
    pendingDetailRequests.set(pendingDetailKey, {
      ...pendingDetails,
      _expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    });
    await bot.sendMessage(
      msg.chat.id,
      buildMissingDetailsRequestMessage(
        pendingDetails.parsedCards[nextMissingIndex],
        nextMissingIndex,
        pendingDetails.parsedCards.length
      )
    );
    return true;
  }

  pendingDetailRequests.delete(pendingDetailKey);
  await sendSaveConfirmation(
    bot,
    msg.chat.id,
    telegramId,
    pendingDetails.parsedCards,
    pendingDetails.parseMode
  );
  return true;
}

async function handleSaveCard(bot, msg, session) {
  const { vaultPin, encryptionSalt } = session;
  const telegramId = getTelegramIdFromMessageLike(msg);

  try {
    if (isMultiImageSubmission(msg)) {
      await bot.sendMessage(
        msg.chat.id,
        `${WARNING} Multiple images in one message are not supported yet\\. Please send one image at a time\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    if (await handlePendingDetailsResponse(bot, msg, telegramId)) {
      return;
    }

    const saveLimit = await checkSaveLimit(telegramId);
    if (!saveLimit.allowed) {
      track("error.rate_limit", telegramId, { limit_type: "save" });
      await bot.sendMessage(
        msg.chat.id,
        `${WARNING} Save limit reached\\. Try again in ${escMd(saveLimit.retryAfter)} seconds\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    if (isImageMessage(msg)) {
      pendingDetailRequests.delete(getPendingDetailKey(telegramId, msg.chat.id));
      const imageLimit = await checkImageSaveLimit(telegramId);
      if (!imageLimit.allowed) {
        track("error.rate_limit", telegramId, { limit_type: "image_save" });
        await bot.sendMessage(
          msg.chat.id,
          `${WARNING} Image save limit reached\\. Try again tomorrow or send the card details as plain text\\.`,
          { parse_mode: "MarkdownV2" }
        );
        return;
      }

      let parseResult;
      const indicator = await startProcessingIndicator(bot, msg.chat.id, `${FOLDER} Reading your gift card image...`);
      try {
        parseResult = await parseCardsFromImage(bot, msg, telegramId);
      } catch (error) {
        if (isVertexFallbackError(error)) {
          logWarn("Vertex temporarily unavailable during image save", { telegramId, code: error.code });
          await bot.sendMessage(msg.chat.id, buildPlainTextFallbackMessage(), { parse_mode: "MarkdownV2" });
          return;
        }
        throw error;
      } finally {
        await indicator.stop();
      }

      const parsedCards = parseResult.cards;

      if (!parsedCards.length) {
        track("card.save_image_parse_failed", telegramId);
        await bot.sendMessage(msg.chat.id, buildPlainTextFallbackMessage(), { parse_mode: "MarkdownV2" });
        return;
      }

      // Filter out cards already saved
      const newCards = [];
      for (const parsed of parsedCards) {
        const duplicate = await findDuplicateCard(telegramId, vaultPin, encryptionSalt, parsed.brand, parsed.code);
        if (!duplicate) newCards.push(parsed);
      }

      if (!newCards.length) {
        await bot.sendMessage(
          msg.chat.id,
          `${WARNING} All detected gift cards are already saved in your vault\\.`,
          { parse_mode: "MarkdownV2" }
        );
        return;
      }

      if (await requestMissingDetails(bot, msg.chat.id, telegramId, newCards, parseResult.mode)) {
        track("card.save_image_details_requested", telegramId, {
          card_count: newCards.length,
          missing_amount_count: newCards.filter((card) => getMissingDetails(card).needsAmount).length,
          missing_expiry_count: newCards.filter((card) => getMissingDetails(card).needsExpiry).length,
        });
        return;
      }

      await sendSaveConfirmation(bot, msg.chat.id, telegramId, newCards, parseResult.mode);
      return;
    }

    // Text path — single card, save immediately
    let parseResult;
    try {
      parseResult = await parseCardFromText(msg, telegramId);
    } catch (error) {
      if (isVertexFallbackError(error)) {
        logWarn("Vertex temporarily unavailable during text save", { telegramId, code: error.code });
          await bot.sendMessage(msg.chat.id, buildPlainTextFallbackMessage(), { parse_mode: "MarkdownV2" });
          return;
        }
      throw error;
    }

    const parsed = parseResult.card;

    if (!parsed) {
      await bot.sendMessage(msg.chat.id, buildPlainTextFallbackMessage(), { parse_mode: "MarkdownV2" });
      return;
    }

    const duplicateCard = await findDuplicateCard(telegramId, vaultPin, encryptionSalt, parsed.brand, parsed.code);
    if (duplicateCard) {
      track("card.save_duplicate", telegramId, { brand: parsed.brand });
      await bot.sendMessage(
        msg.chat.id,
        `${WARNING} This ${escMd(parsed.brand)} gift card is already saved with the same code\\. Please use /show or /search to view it\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    await doSaveCard(bot, msg.chat.id, telegramId, vaultPin, encryptionSalt, parsed, `text_${parseResult.mode}`);
  } catch (error) {
    track("error.handler", telegramId, { handler: "save_card", error_code: error?.code });
    logError("Save card handler error", error, { telegramId });
    await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
}

async function handleShow(bot, msg, session) {
  const { vaultPin, encryptionSalt } = session;
  const telegramId = getTelegramIdFromMessageLike(msg);

  try {
    bot.sendChatAction(msg.chat.id, "typing").catch(err => logWarn("sendChatAction failed", { error: err.message }));
    const [cardsLimit, prefetchedCards] = await Promise.all([
      checkCardsLimit(telegramId),
      fetchCards(telegramId, { includeRedeemed: false }),
    ]);

    if (!cardsLimit.allowed) {
      await bot.sendMessage(
        msg.chat.id,
        `${WARNING} Too many /show requests\\. Please wait ${escMd(cardsLimit.retryAfter)} seconds\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    const { cards, sent } = await sendCardList(bot, msg.chat.id, telegramId, vaultPin, encryptionSalt, { includeRedeemed: false, forceRefresh: true, prefetchedCards });
    track("card.viewed", telegramId, { card_count: cards.length });

    if (!sent && !cards.length) {
      await bot.sendMessage(msg.chat.id, `${FOLDER} No active gift cards\\. Send a card image or use /show\\_all to include redeemed cards\\.`, {
        parse_mode: "MarkdownV2",
      });
    }
  } catch (error) {
    logError("Show handler error", error, { telegramId });
    await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
}

async function handleShowAll(bot, msg, session) {
  const { vaultPin, encryptionSalt } = session;
  const telegramId = getTelegramIdFromMessageLike(msg);

  try {
    bot.sendChatAction(msg.chat.id, "typing").catch(err => logWarn("sendChatAction failed", { error: err.message }));
    const [cardsLimit, prefetchedCards] = await Promise.all([
      checkCardsLimit(telegramId),
      fetchCards(telegramId, { includeRedeemed: true }),
    ]);

    if (!cardsLimit.allowed) {
      await bot.sendMessage(
        msg.chat.id,
        `${WARNING} Too many /show\\_all requests\\. Please wait ${escMd(cardsLimit.retryAfter)} seconds\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    const { cards, sent } = await sendCardList(bot, msg.chat.id, telegramId, vaultPin, encryptionSalt, { includeRedeemed: true, forceRefresh: true, prefetchedCards });
    track("card.viewed_all", telegramId, { card_count: cards.length });

    if (!sent && !cards.length) {
      await bot.sendMessage(msg.chat.id, `${FOLDER} No gift cards saved yet\\. Send a card image or text to get started\\.`, {
        parse_mode: "MarkdownV2",
      });
    }
  } catch (error) {
    logError("Show all handler error", error, { telegramId });
    await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
}

async function handleSearch(bot, msg, session, searchTerm) {
  const { vaultPin, encryptionSalt } = session;
  const telegramId = getTelegramIdFromMessageLike(msg);
  const query = String(searchTerm || "").trim();

  try {
    if (query.length > 100) {
      await bot.sendMessage(
        msg.chat.id,
        `${WARNING} Search term is too long\\. Keep it under 100 characters\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    if (!query) {
      await bot.sendMessage(
        msg.chat.id,
        `${WARNING} Use /search \\<brand\\>\\. Example: /search amazon`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    bot.sendChatAction(msg.chat.id, "typing").catch(err => logWarn("sendChatAction failed", { error: err.message }));
    const prefetchedCards = await fetchCards(telegramId, { includeRedeemed: true, searchTerm: query });

    const { cards, sent } = await sendCardList(bot, msg.chat.id, telegramId, vaultPin, encryptionSalt, {
      includeRedeemed: true,
      searchTerm: query,
      forceRefresh: true,
      prefetchedCards,
    });
    track("card.searched", telegramId, { result_count: cards.length, has_results: cards.length > 0 });

    if (!sent && !cards.length) {
      await bot.sendMessage(
        msg.chat.id,
        `${FOLDER} No cards matched *${escMd(query)}*\\. Try /show to see all cards\\.`,
        { parse_mode: "MarkdownV2" }
      );
    }
  } catch (error) {
    logError("Search handler error", error, { telegramId, query });
    await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
}

async function handleDeleteAccount(bot, msg, _session) {
  const telegramId = getTelegramIdFromMessageLike(msg);

  try {
    const cards = await fetchCards(telegramId, { includeRedeemed: true });
    const confirmation = deleteAccountConfirmationMessage(cards.length);
    await bot.sendMessage(msg.chat.id, confirmation.text, {
      parse_mode: "MarkdownV2",
      reply_markup: confirmation.reply_markup,
    });
  } catch (error) {
    logError("Delete account handler error", error, { telegramId });
    await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
}

async function handleDeleteAll(bot, msg, _session) {
  const telegramId = getTelegramIdFromMessageLike(msg);

  try {
    const cards = await fetchCards(telegramId, { includeRedeemed: true });

    if (!cards.length) {
      await bot.sendMessage(msg.chat.id, `${FOLDER} No gift cards found\\.`, {
        parse_mode: "MarkdownV2",
      });
      return;
    }

    const confirmation = deleteAllConfirmationMessage(cards.length);
    await bot.sendMessage(msg.chat.id, confirmation.text, {
      reply_markup: confirmation.reply_markup,
    });
  } catch (error) {
    logError("Delete all handler error", error, { telegramId });
    await bot.sendMessage(msg.chat.id, `${ERROR} Something went wrong\\. Please try again\\.`, {
      parse_mode: "MarkdownV2",
    });
  }
}

async function handleCallback(bot, callbackQuery, session) {
  const { vaultPin, encryptionSalt } = session;
  const telegramId = getTelegramIdFromMessageLike(callbackQuery);
  const data = callbackQuery.data || "";
  const [action, cardIdRaw] = data.split(":");
  const cardId = Number(cardIdRaw);

  try {
    const actionsRequiringCardId = new Set(["delete", "confirm_delete", "cancel_delete", "mark_redeemed"]);

    if (!action || (actionsRequiringCardId.has(action) && (!Number.isInteger(cardId) || cardId <= 0))) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} Invalid action` });
      return;
    }

    if (action === "show_more") {
      const state = getRenderedListState(telegramId, callbackQuery.message.chat.id);
      if (!state) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Nothing more to show." });
        return;
      }

      // Re-fetch from DB to avoid showing deleted/redeemed cards from stale cache
      const fetchedCards = await fetchCards(telegramId, { includeRedeemed: state.includeRedeemed, searchTerm: state.searchTerm });
      const { botCards: freshAllCards, webOnlyCards } = splitBotReadableCards(fetchedCards);
      await sendWebOnlyNotice(bot, callbackQuery.message.chat.id, webOnlyCards.length);

      // currentOffset is how many cards were shown before — find where we are in the fresh list
      const currentOffset = state.offset || 0;
      const nextOffset = currentOffset + PAGE_SIZE;
      const nextBatch = freshAllCards.slice(currentOffset, nextOffset);

      if (!nextBatch.length) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "All cards are shown." });
        return;
      }

      const decryptResults = await Promise.allSettled(
        nextBatch.map(card => decryptCardSecrets(card, vaultPin, encryptionSalt).then(s => ({ card, ...s })))
      );
      const failedIndex = decryptResults.findIndex(r => r.status === "rejected");
      if (failedIndex !== -1) {
        logError("Card decryption error during show_more", decryptResults[failedIndex].reason, { telegramId, cardId: nextBatch[failedIndex].id });
        await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} Could not decrypt. Check your vault PIN.` });
        return;
      }

      await bot.answerCallbackQuery(callbackQuery.id);

      // Restore previous last card's keyboard (strip show_more row)
      if (state.showMoreMsgId && state.lastCardBaseRows) {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: state.lastCardBaseRows },
          { chat_id: callbackQuery.message.chat.id, message_id: state.showMoreMsgId }
        ).catch(() => {});
      }

      const showMoreChatId = callbackQuery.message.chat.id;
      const newMessageIds = [...state.messageIds];
      const globalOffset = state.offset || 0;
      const decryptedBatch = decryptResults.map(r => r.value);
      const newShowMoreRow = buildShowMoreRow(nextOffset, freshAllCards.length);
      let newLastCardBaseRows = null;
      for (let i = 0; i < decryptedBatch.length; i++) {
        const { card, decryptedCode, decryptedPin } = decryptedBatch[i];
        const isLast = i === decryptedBatch.length - 1;
        const baseRows = buildCardKeyboard(card, decryptedCode, decryptedPin);
        if (isLast) newLastCardBaseRows = baseRows;
        const rows = (isLast && newShowMoreRow) ? [...baseRows, newShowMoreRow] : baseRows;
        const sent = await bot.sendMessage(showMoreChatId, cardMessage(card, globalOffset + i + 1, decryptedCode, decryptedPin), {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: rows },
        });
        newMessageIds.push(sent.message_id);
      }

      const newShowMoreMsgId = newShowMoreRow ? newMessageIds[newMessageIds.length - 1] : null;
      setRenderedListState(telegramId, showMoreChatId, { ...state, allCards: freshAllCards, messageIds: newMessageIds, offset: nextOffset, showMoreMsgId: newShowMoreMsgId, lastCardBaseRows: newLastCardBaseRows });
      return;
    }

    if (action === "confirm_save") {
      const pendingSaveKey = getPendingSaveKey(telegramId, callbackQuery.message.chat.id);
      const pendingSave = pendingSaveConfirmations.get(pendingSaveKey);
      pendingSaveConfirmations.delete(pendingSaveKey);

      if (!pendingSave) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} No pending save found. Try sending the image again.` });
        return;
      }

      await bot.answerCallbackQuery(callbackQuery.id);
      try {
        await bot.deleteMessage(pendingSave.chatId, pendingSave.promptMessageId);
      } catch (deleteError) {
        logWarn("Failed to delete save confirmation prompt", { telegramId, error: deleteError.message });
      }

      for (const parsed of pendingSave.parsedCards) {
        if (!Number.isFinite(Number(parsed.amount)) || Number(parsed.amount) <= 0) {
          await bot.sendMessage(
            callbackQuery.message.chat.id,
            `${WARNING} Amount is required before saving ${escMd(parsed.brand)}\\. Please send the image again\\.`,
            { parse_mode: "MarkdownV2" }
          );
          continue;
        }

        const saveLimit = await checkSaveLimit(telegramId);
        if (!saveLimit.allowed) {
          track("error.rate_limit", telegramId, { limit_type: "save" });
          await bot.sendMessage(
            callbackQuery.message.chat.id,
            `${WARNING} Daily save limit reached\\. Remaining cards were not saved\\.`,
            { parse_mode: "MarkdownV2" }
          );
          break;
        }
        const duplicate = await findDuplicateCard(telegramId, vaultPin, encryptionSalt, parsed.brand, parsed.code);
        if (!duplicate) {
          await doSaveCard(
            bot,
            callbackQuery.message.chat.id,
            telegramId,
            vaultPin,
            encryptionSalt,
            parsed,
            `image_${pendingSave.parseMode || "unknown"}`
          );
        }
      }
      return;
    }

    if (action === "cancel_save") {
      const pendingSaveKey = getPendingSaveKey(telegramId, callbackQuery.message.chat.id);
      const pendingSave = pendingSaveConfirmations.get(pendingSaveKey);
      pendingSaveConfirmations.delete(pendingSaveKey);
      track("card.save_cancelled", telegramId, { card_count: pendingSave?.parsedCards?.length ?? 0 });

      if (pendingSave?.promptMessageId) {
        try {
          await bot.deleteMessage(pendingSave.chatId, pendingSave.promptMessageId);
        } catch (deleteError) {
          logWarn("Failed to delete save confirmation prompt on cancel", { telegramId, error: deleteError.message });
        }
      }

      await bot.answerCallbackQuery(callbackQuery.id, { text: "Cancelled" });
      return;
    }

    if (action === "delete") {
      const card = await fetchCardById(cardId, telegramId);
      if (!card) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} Card not found` });
        return;
      }

      const confirmation = deleteConfirmationMessage(cardId);
      await bot.answerCallbackQuery(callbackQuery.id);
      const sentConfirmation = await bot.sendMessage(callbackQuery.message.chat.id, confirmation.text, {
        reply_markup: confirmation.reply_markup,
      });
      pendingDeleteConfirmations.set(getPendingDeleteKey(telegramId, cardId), {
        chatId: callbackQuery.message.chat.id,
        promptMessageId: sentConfirmation.message_id,
        brand: card.brand,
        listState: getRenderedListState(telegramId, callbackQuery.message.chat.id),
        _expiresAt: Date.now() + CONFIRMATION_TTL_MS,
      });
      return;
    }

    if (action === "cancel_delete") {
      const pendingDeleteKey = getPendingDeleteKey(telegramId, cardId);
      const pendingDelete = pendingDeleteConfirmations.get(pendingDeleteKey);
      pendingDeleteConfirmations.delete(pendingDeleteKey);

      if (pendingDelete?.chatId && pendingDelete?.promptMessageId) {
        try {
          await bot.deleteMessage(pendingDelete.chatId, pendingDelete.promptMessageId);
        } catch (deleteError) {
          logWarn("Failed to delete cancellation prompt", { telegramId, cardId, error: deleteError.message });
        }
      }

      await bot.answerCallbackQuery(callbackQuery.id, { text: "Cancelled" });
      return;
    }

    if (action === "confirm_delete") {
      const card = await fetchCardById(cardId, telegramId);
      if (!card) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} Card not found` });
        return;
      }

      await deleteSingleCardData(cardId, telegramId);

      const pendingDeleteKey = getPendingDeleteKey(telegramId, cardId);
      const pendingDelete = pendingDeleteConfirmations.get(pendingDeleteKey);
      pendingDeleteConfirmations.delete(pendingDeleteKey);

      const deletedLabel = pendingDelete ? `${getBrandEmoji(pendingDelete.brand)} ${pendingDelete.brand}` : `${getBrandEmoji(card.brand)} ${card.brand}`;
      const listState = pendingDelete?.listState || getRenderedListState(telegramId, callbackQuery.message.chat.id) || { includeRedeemed: false, searchTerm: null };

      await bot.answerCallbackQuery(callbackQuery.id, { text: `${TRASH} Deleted` });
      if (pendingDelete?.promptMessageId) {
        try {
          await bot.deleteMessage(pendingDelete.chatId, pendingDelete.promptMessageId);
        } catch (deleteError) {
          logWarn("Failed to delete confirmation prompt", { telegramId, cardId, error: deleteError.message });
        }
      }
      track("card.deleted", telegramId, { brand: card.brand });
      await bot.sendMessage(
        callbackQuery.message.chat.id,
        `${SUCCESS} Deleted ${escMd(deletedLabel)}`,
        { parse_mode: "MarkdownV2" }
      );
      const refreshedList = await sendCardList(bot, callbackQuery.message.chat.id, telegramId, vaultPin, encryptionSalt, {
        includeRedeemed: listState.includeRedeemed,
        searchTerm: listState.searchTerm,
      });

      if (!refreshedList.sent && !refreshedList.cards.length) {
        await bot.sendMessage(callbackQuery.message.chat.id, getEmptyStateMessage(listState), {
          parse_mode: "MarkdownV2",
        });
      }
      return;
    }

    if (action === "confirm_delete_account") {
      await deleteAccountData(telegramId);
      forgetUserByTelegramId(telegramId);
      await clearPendingOnboarding(telegramId);
      await clearUserRateLimits(telegramId);
      await endSession(telegramId);
      track("user.account_deleted", telegramId);
      await clearRenderedListState(bot, telegramId, callbackQuery.message.chat.id);
      await bot.answerCallbackQuery(callbackQuery.id, { text: `${TRASH} Account deleted` });
      await bot.editMessageText(`${TRASH} Your account and all data have been permanently deleted\\.`, {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        parse_mode: "MarkdownV2",
        reply_markup: { inline_keyboard: [] },
      });
      return;
    }

    if (action === "cancel_delete_account") {
      await bot.answerCallbackQuery(callbackQuery.id, { text: "Cancelled" });
      return;
    }

    if (action === "confirm_delete_all") {
      await deleteAllCardsData(telegramId);
      track("card.delete_all", telegramId);
      await clearRenderedListState(bot, telegramId, callbackQuery.message.chat.id);
      await bot.answerCallbackQuery(callbackQuery.id, { text: `${TRASH} All gift cards deleted` });
      await bot.editMessageText(`${TRASH} All gift cards deleted\\.`, {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        parse_mode: "MarkdownV2",
        reply_markup: { inline_keyboard: [] },
      });
      return;
    }

    if (action === "cancel_delete_all") {
      await bot.answerCallbackQuery(callbackQuery.id, { text: "Cancelled" });
      return;
    }

    if (action === "mark_redeemed") {
      const card = await fetchCardById(cardId, telegramId);
      if (!card) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} Card not found` });
        return;
      }

      const redeemedAt = new Date().toISOString();
      const { error } = await withSupabaseRetry(() =>
        supabase
          .from("gift_cards_vault")
          .update({ is_redeemed: true, redeemed_at: redeemedAt })
          .eq("id", cardId)
          .eq("telegram_id", telegramId)
      );

      if (error) {
        throw error;
      }

      logInfo("Card redeemed", { telegramId, cardId, brand: card.brand, redeemedAt });
      logCardEvent(telegramId, cardId, "redeemed", { brand: card.brand, amount: card.amount, redeemedAt }).catch(() => {});

      const listState = getRenderedListState(telegramId, callbackQuery.message.chat.id) || { includeRedeemed: false, searchTerm: null };
      track("card.marked_redeemed", telegramId, { brand: card.brand });
      await bot.answerCallbackQuery(callbackQuery.id, { text: `${SUCCESS} Marked as redeemed` });
      const refreshedList = await sendCardList(bot, callbackQuery.message.chat.id, telegramId, vaultPin, encryptionSalt, {
        includeRedeemed: listState.includeRedeemed,
        searchTerm: listState.searchTerm,
      });

      if (!refreshedList.sent && !refreshedList.cards.length) {
        await bot.sendMessage(callbackQuery.message.chat.id, getEmptyStateMessage(listState), {
          parse_mode: "MarkdownV2",
        });
      }
      return;
    }

    await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} Invalid action` });
  } catch (error) {
    track("error.handler", telegramId, { handler: "callback", error_code: error?.code });
    logError("Callback handler error", error, { telegramId, action, cardId });
    await bot.answerCallbackQuery(callbackQuery.id, { text: `${ERROR} Something went wrong. Please try again.` });
  }
}

module.exports = {
  handleShow,
  handleShowAll,
  handleCallback,
  handleDeleteAccount,
  handleDeleteAll,
  handleSaveCard,
  handleSearch,
  isImageMessage,
  sendCards,
  shouldIgnoreMediaGroupMessage,
};
