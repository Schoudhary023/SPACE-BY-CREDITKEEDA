const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeExpiryDate,
  parseAmountInput,
  parseCardInput,
  parseMissingCardDetailsInput,
  sanitizeParsedCard,
} = require("../lib/cardParser");

test("parseCardInput parses the strict fallback format", () => {
  assert.deepEqual(parseCardInput("Amazon 1000 ABCD1234 5678 2026-10-10"), {
    brand: "Amazon",
    amount: 1000,
    code: "ABCD1234",
    pin: "5678",
    expiryDate: "2026-10-10",
  });
});

test("parseCardInput allows missing pin and expiry", () => {
  assert.deepEqual(parseCardInput("Amazon 1000 ABCD1234"), {
    brand: "Amazon",
    amount: 1000,
    code: "ABCD1234",
    pin: null,
    expiryDate: null,
  });
});

test("parseCardInput accepts currency and comma formatted amounts", () => {
  assert.deepEqual(parseCardInput("Amazon ₹1,000 ABCD1234"), {
    brand: "Amazon",
    amount: 1000,
    code: "ABCD1234",
    pin: null,
    expiryDate: null,
  });
});

test("parseCardInput treats the last expiry-looking token as expiry", () => {
  assert.deepEqual(parseCardInput("Amazon 1000 ABCD1234 2026-10-10"), {
    brand: "Amazon",
    amount: 1000,
    code: "ABCD1234",
    pin: null,
    expiryDate: "2026-10-10",
  });
});

test("normalizeExpiryDate expands month year values", () => {
  assert.equal(normalizeExpiryDate("02/26"), "2026-02-28");
});

test("normalizeExpiryDate parses natural language dates", () => {
  assert.equal(normalizeExpiryDate("20th June 2026"), "2026-06-20");
});

test("normalizeExpiryDate parses uppercase ordinal month dates", () => {
  assert.equal(normalizeExpiryDate("31ST JAN 2027"), "2027-01-31");
});

test("normalizeExpiryDate parses Indian day-month-year dates", () => {
  assert.equal(normalizeExpiryDate("31/12/2026"), "2026-12-31");
  assert.equal(normalizeExpiryDate("5/6/2026"), "2026-06-05");
  assert.equal(normalizeExpiryDate("05-06-2026"), "2026-06-05");
  assert.equal(normalizeExpiryDate("31/02/2026"), null);
});

test("sanitizeParsedCard rejects uncertain AI output", () => {
  assert.equal(
    sanitizeParsedCard({
      brand: "Amazon",
      amount: 1000,
      code: "ABCD1234",
      pin: "5678",
      expiryDate: "2026-10-10",
      confidence: 0.5,
    }),
    null
  );
});

test("sanitizeParsedCard keeps optional pin and expiry as nullable", () => {
  assert.deepEqual(
    sanitizeParsedCard({
      brand: "Amazon",
      amount: 1000,
      code: "ABCD1234",
      pin: null,
      expiryDate: null,
      confidence: 0.95,
    }),
    {
      brand: "Amazon",
      amount: 1000,
      code: "ABCD1234",
      pin: null,
      expiryDate: null,
    }
  );
});

test("sanitizeParsedCard can keep image cards with missing amount for follow-up", () => {
  assert.deepEqual(
    sanitizeParsedCard(
      {
        brand: "Amazon",
        amount: null,
        code: "YW8CSWP2ZDF6FR",
        pin: null,
        expiryDate: null,
        confidence: 0.75,
      },
      { minConfidence: 0.6, requireAmount: false }
    ),
    {
      brand: "Amazon",
      amount: null,
      code: "YW8CSWP2ZDF6FR",
      pin: null,
      expiryDate: null,
    }
  );
});

test("sanitizeParsedCard still requires amount by default", () => {
  assert.equal(
    sanitizeParsedCard({
      brand: "Amazon",
      amount: null,
      code: "YW8CSWP2ZDF6FR",
      pin: null,
      expiryDate: null,
      confidence: 0.95,
    }),
    null
  );
});

test("parseAmountInput accepts amount-only follow-up values", () => {
  assert.equal(parseAmountInput("1000"), 1000);
  assert.equal(parseAmountInput("INR 1,000"), 1000);
  assert.equal(parseAmountInput("Rs. 500"), 500);
  assert.equal(parseAmountInput("500.50"), null);
  assert.equal(parseAmountInput("Amazon 500"), null);
});

test("parseMissingCardDetailsInput parses amount and expiry together", () => {
  assert.deepEqual(
    parseMissingCardDetailsInput("1000 31/12/2026", { needsAmount: true, needsExpiry: true }),
    {
      amount: 1000,
      expiryDate: "2026-12-31",
      skippedExpiry: false,
    }
  );

  assert.deepEqual(
    parseMissingCardDetailsInput("INR 1,000 skip", { needsAmount: true, needsExpiry: true }),
    {
      amount: 1000,
      expiryDate: null,
      skippedExpiry: true,
    }
  );
});

test("parseMissingCardDetailsInput accepts expiry-only follow-up values", () => {
  assert.deepEqual(
    parseMissingCardDetailsInput("2026-12-31", { needsExpiry: true }),
    {
      amount: null,
      expiryDate: "2026-12-31",
      skippedExpiry: false,
    }
  );

  assert.deepEqual(
    parseMissingCardDetailsInput("none", { needsExpiry: true }),
    {
      amount: null,
      expiryDate: null,
      skippedExpiry: true,
    }
  );
});

test("sanitizeParsedCard accepts a lower explicit confidence threshold", () => {
  assert.deepEqual(
    sanitizeParsedCard(
      {
        brand: "Amazon",
        amount: 1000,
        code: "ABCD1234",
        pin: null,
        expiryDate: null,
        confidence: 0.7,
      },
      { minConfidence: 0.6 }
    ),
    {
      brand: "Amazon",
      amount: 1000,
      code: "ABCD1234",
      pin: null,
      expiryDate: null,
    }
  );
});

test("sanitizeParsedCard rejects currency labels as brands", () => {
  assert.equal(
    sanitizeParsedCard({
      brand: "INR",
      amount: 1000,
      code: "QYEDWZ4WA73RM",
      pin: "6004910014703812",
      expiryDate: "2027-02-28",
      confidence: 0.95,
    }),
    null
  );
});
