const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCommand, sliceMessageEntities } = require("../lib/commandParser");

test("parseCommand preserves raw broadcast line breaks", () => {
  assert.deepEqual(parseCommand("/broadcast\nLine one\n\nLine two"), {
    command: "/broadcast",
    args: "Line one Line two",
    rawArgs: "Line one\n\nLine two",
    rawArgsOffset: 11,
  });
});

test("parseCommand keeps normalized args for regular commands", () => {
  assert.deepEqual(parseCommand("/block   12345   too   much"), {
    command: "/block",
    args: "12345 too much",
    rawArgs: "12345   too   much",
    rawArgsOffset: 9,
  });
});

test("sliceMessageEntities adjusts entities into the raw argument range", () => {
  assert.deepEqual(
    sliceMessageEntities(
      [
        { offset: 0, length: 10, type: "bot_command" },
        { offset: 11, length: 4, type: "bold" },
        { offset: 17, length: 4, type: "italic" },
      ],
      11,
      "Bold\n\nText".length
    ),
    [
      { offset: 0, length: 4, type: "bold" },
      { offset: 6, length: 4, type: "italic" },
    ]
  );
});
