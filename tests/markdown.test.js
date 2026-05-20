const test = require("node:test");
const assert = require("node:assert/strict");

const { escMd } = require("../lib/markdown");

test("escMd escapes markdown v2 control characters", () => {
  assert.equal(escMd("Price_[test]-100!"), "Price\\_\\[test\\]\\-100\\!");
});
