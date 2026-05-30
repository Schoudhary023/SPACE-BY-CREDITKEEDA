function normalizeArgs(rawArgs) {
  return String(rawArgs || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function parseCommand(text) {
  const source = String(text || "");
  const leadingWhitespace = source.match(/^\s*/)?.[0].length || 0;
  const withoutLeading = source.slice(leadingWhitespace);

  if (!withoutLeading.startsWith("/")) {
    return { command: null, args: "", rawArgs: "", rawArgsOffset: 0 };
  }

  const rawCommand = withoutLeading.match(/^\/\S+/)?.[0] || "";
  const command = rawCommand.split("@")[0].toLowerCase();
  const afterCommandOffset = leadingWhitespace + rawCommand.length;
  const separator = source.slice(afterCommandOffset).match(/^[ \t]*(?:\r?\n)?/)?.[0] || "";
  const rawArgsOffset = afterCommandOffset + separator.length;
  const rawArgs = source.slice(rawArgsOffset).replace(/\s+$/u, "");

  return {
    command,
    args: normalizeArgs(rawArgs),
    rawArgs,
    rawArgsOffset,
  };
}

function sliceMessageEntities(entities, startOffset, textLength) {
  if (!Array.isArray(entities) || textLength <= 0) {
    return [];
  }

  const endOffset = startOffset + textLength;

  return entities
    .filter((entity) => {
      const entityStart = Number(entity.offset);
      const entityEnd = entityStart + Number(entity.length);
      return entityStart >= startOffset && entityEnd <= endOffset;
    })
    .map((entity) => ({
      ...entity,
      offset: Number(entity.offset) - startOffset,
    }));
}

module.exports = {
  parseCommand,
  sliceMessageEntities,
};
