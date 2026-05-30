const { createLinkToken } = require("../lib/vaultLink");
const { getTelegramUserForLink } = require("../lib/vaultUsers");

// Set SPACE_APP_URL env var to your deployed Space web app URL.
// e.g. SPACE_APP_URL=https://your-space-domain.com
const PROD_SPACE_BASE_URL = "https://your-space-domain.com";

function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function getSpaceBaseUrl() {
  const appUrl = normalizeBaseUrl(process.env.SPACE_APP_URL);
  if (appUrl) {
    return appUrl;
  }

  const devUiEnabled = String(process.env.DEV_UI_ENABLED || "").toLowerCase() === "true";
  if (devUiEnabled) {
    const apiPort = process.env.API_PORT || process.env.PORT || "3000";
    return `http://localhost:${apiPort}`;
  }

  return PROD_SPACE_BASE_URL;
}

async function sendMovedToWebMessage(bot, chatId) {
  const url = getSpaceBaseUrl();
  await bot.sendMessage(
    chatId,
    [
      "👋 Space has moved to the web.",
      "",
      `Open ${url} to access your vault.`,
      "This Telegram bot is being phased out, so linked vaults are managed from Space web only.",
    ].join("\n")
  );
}

function isLocalBaseUrl(url) {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function handleLinkWeb(bot, msg) {
  const telegramId = String(msg.from.id);
  const chatId = msg.chat.id;

  const user = await getTelegramUserForLink(telegramId);
  if (!user) {
    await bot.sendMessage(
      chatId,
      "You don't have a KeedaVault yet. Send /start to set one up first."
    );
    return;
  }

  if (user.auth_user_id) {
    await bot.sendMessage(chatId, "Your vault is already linked and managed from Space web.");
    return;
  }

  const { token } = await createLinkToken(user.user_uuid, "telegram_to_web");
  const spaceBaseUrl = getSpaceBaseUrl();
  const link = `${spaceBaseUrl}/link?token=${token}`;

  if (isLocalBaseUrl(spaceBaseUrl)) {
    await bot.sendMessage(
      chatId,
      [
        "Link your vault to Space",
        "",
        "Telegram cannot open localhost URLs from inline buttons.",
        "Open this URL in your local browser:",
        "",
        link,
        "",
        "The link expires in 15 minutes.",
      ].join("\n")
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    "Link your vault to Space\n\nTap the button below to connect your Telegram vault to your Space account. The link expires in 15 minutes.",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "Open Space to Link", url: link }]],
      },
    }
  );
}

module.exports = { getSpaceBaseUrl, handleLinkWeb, isLocalBaseUrl, sendMovedToWebMessage };
