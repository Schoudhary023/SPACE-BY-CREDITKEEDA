const ESCAPE_PATTERN = /([_\*\[\]()~`>#+\-=|{}.!\\])/g;

function escMd(value) {
  return String(value ?? "").replace(ESCAPE_PATTERN, "\\$1");
}

module.exports = {
  escMd,
};
