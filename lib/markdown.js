const ESCAPE_PATTERN = /([_\*\[\]()~`>#+\-=|{}.!\\])/g;

// Telegram MarkdownV2 treats many normal characters as formatting syntax.
// Escape all user-controlled values before interpolating them into messages.
function escMd(value) {
  return String(value ?? "").replace(ESCAPE_PATTERN, "\\$1");
}

module.exports = {
  escMd,
};
