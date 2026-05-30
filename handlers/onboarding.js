const { getPendingOnboarding } = require("../lib/runtimeStore");

async function isAwaitingOnboarding(telegramId) {
  return Boolean(await getPendingOnboarding(telegramId));
}

module.exports = {
  isAwaitingOnboarding,
};
