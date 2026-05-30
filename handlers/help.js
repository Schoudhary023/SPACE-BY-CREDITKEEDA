const PIN = "\u{1F4CC}";
const LIST = "\u{1F4CB}";
const LOCK = "\u{1F510}";
const MEGAPHONE = "\u{1F4E2}";
const EM_DASH = "\u2014";

async function sendHelp(bot, chatId) {
  const message = [
    `${MEGAPHONE} *Space is moving to the web\\.*`,
    "Use /link\\_web to connect your vault to Space web\\. The bot will stop accepting new cards soon\\.",
    "",
    `${PIN} *How to save a card:*`,
    "Send card text in a natural format, forward the platform message, or upload a screenshot\\.",
    "The bot will try to extract brand, amount, code, and optional PIN or expiry safely\\.",
    "Example: `Amazon 1000 ABCD1234 5678 2026\\-10\\-10` or `Amazon 1000 ABCD1234`",
    "",
    `${LIST} *Commands:*`,
    `/show ${EM_DASH} View your active gift cards`,
    `/show\\_all ${EM_DASH} View all gift cards including redeemed`,
    `/search \\<brand\\> ${EM_DASH} Search gift cards by brand`,
    `/link\\_web ${EM_DASH} Link this Telegram vault to Space web`,
    `/delete\\_all ${EM_DASH} Delete all your gift cards`,
    `/delete\\_account ${EM_DASH} Permanently delete your account and all data`,
    `/help ${EM_DASH} Show this message`,
    `/end ${EM_DASH} End the current unlocked session`,
    "",
    `${LOCK} *Security:*`,
    "Your card codes and PINs are encrypted with your vault PIN\\.",
    "Even we cannot read them\\.",
    "",
    "Privacy Policy: creditkeeda\\.com/privacy/space",
    "Support: @creditkeeda",
  ].join("\n");

  await bot.sendMessage(chatId, message, { parse_mode: "MarkdownV2" });
}

module.exports = {
  sendHelp,
};
