const { checkRateLimit } = require("./runtimeStore");

const IMAGE_SAVE_DAILY_LIMIT = process.env.IMAGE_SAVE_DAILY_LIMIT
  ? Number(process.env.IMAGE_SAVE_DAILY_LIMIT)
  : 5;

// Each feature gets its own bucket so heavy reads do not block saves, while
// image parsing stays capped because it can call external AI services.
async function checkGeneralLimit(telegramId) {
  return checkRateLimit(`general:${telegramId}`, 10, 60 * 1000);
}

async function checkCardsLimit(telegramId) {
  return checkRateLimit(`cards:${telegramId}`, 20, 60 * 60 * 1000);
}

async function checkSaveLimit(telegramId) {
  return checkRateLimit(`save:${telegramId}`, 30, 24 * 60 * 60 * 1000);
}

async function checkImageSaveLimit(telegramId) {
  return checkRateLimit(
    `image_save:${telegramId}`,
    IMAGE_SAVE_DAILY_LIMIT,
    24 * 60 * 60 * 1000,
  );
}

module.exports = {
  checkGeneralLimit,
  checkCardsLimit,
  checkImageSaveLimit,
  checkSaveLimit,
};
