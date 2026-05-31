const test = require("node:test");
const assert = require("node:assert/strict");

const { formatDisplayDate, saveConfirmationMessage } = require("../lib/cardDisplay");

test("formatDisplayDate renders ISO dates as dd Mon YYYY", () => {
  assert.equal(formatDisplayDate("2026-12-31"), "31 Dec 2026");
  assert.equal(formatDisplayDate("2026-06-05"), "05 Jun 2026");
  assert.equal(formatDisplayDate(null), "");
});

test("saveConfirmationMessage shows expiry in dd Mon YYYY", () => {
  const confirmation = saveConfirmationMessage([
    {
      brand: "Amazon",
      amount: 1000,
      code: "ABCD1234",
      pin: null,
      expiryDate: "2026-12-31",
    },
  ]);

  assert.match(confirmation.text, /Expires: 31 Dec 2026/);
  assert.doesNotMatch(confirmation.text, /2026-12-31/);
});
