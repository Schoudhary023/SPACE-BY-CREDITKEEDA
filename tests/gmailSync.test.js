const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || "test-secret";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key";

const { _internals } = require("../lib/gmailSync");

test("stripHtml removes tags and decodes entities", () => {
  assert.equal(
    _internals.stripHtml("<p>Hello&nbsp;<strong>Amazon</strong><br>Code: ABCD&amp;123</p>"),
    "Hello Amazon\nCode: ABCD&123"
  );
});

test("decodeBase64Url decodes Gmail body payloads", () => {
  const encoded = Buffer.from("Claim code: ZXCV1234", "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  assert.equal(_internals.decodeBase64Url(encoded), "Claim code: ZXCV1234");
});

test("buildMessageCandidateText combines subject snippet and body", () => {
  const body = Buffer.from("Amazon gift card code ABCD1234", "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const text = _internals.buildMessageCandidateText({
    snippet: "Use your code",
    payload: {
      headers: [
        { name: "Subject", value: "Your voucher is here" },
        { name: "From", value: "store@example.com" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: body },
        },
      ],
    },
  });

  assert.match(text, /Subject: Your voucher is here/);
  assert.match(text, /From: store@example\.com/);
  assert.match(text, /Amazon gift card code ABCD1234/);
});

test("isExpired only marks past dates as expired", () => {
  assert.equal(_internals.isExpired("2099-01-01"), false);
  assert.equal(_internals.isExpired("2000-01-01"), true);
  assert.equal(_internals.isExpired(null), false);
});

test("shouldExcludeEmailText filters Amazon cashback emails", () => {
  assert.equal(_internals.shouldExcludeEmailText("Amazon Pay: You've got this cashback in your account"), true);
  assert.equal(_internals.shouldExcludeEmailText("Amazon gift card worth Rs 500. Claim code: ABCD1234"), false);
});

test("hasGiftCardIntent requires gift card or voucher signals", () => {
  assert.equal(_internals.hasGiftCardIntent("Amazon gift card worth Rs 500. Claim code: ABCD1234"), true);
  assert.equal(_internals.hasGiftCardIntent("Hi Saurabh, your payment was successful"), false);
});

test("validateEmailParsedCard rejects email metadata junk", () => {
  assert.equal(
    _internals.validateEmailParsedCard({
      brand: "Subject:",
      amount: 1535,
      code: "was",
      pin: "paid on Amazon.in From: Amazon Pay India <no-reply@amazonpay.in>",
      expiryDate: "2026-05-19",
    }),
    false
  );
});

test("validateEmailParsedCard accepts plausible gift card data", () => {
  assert.equal(
    _internals.validateEmailParsedCard({
      brand: "Amazon",
      amount: 500,
      code: "ABCD123456",
      pin: "1234",
      expiryDate: "2026-12-31",
    }),
    true
  );
});

test("buildMessageCandidateText truncates large payloads safely", () => {
  const body = "A".repeat(13000);
  const encoded = Buffer.from(body, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const text = _internals.buildMessageCandidateText({
    payload: {
      headers: [],
      mimeType: "text/plain",
      body: { data: encoded },
    },
  });

  assert.equal(text.length, 12000);
});

test("addLookbackToQuery adds 30 day Gmail window and chat exclusion", () => {
  assert.equal(
    _internals.addLookbackToQuery("\"gift card\"", 30),
    "\"gift card\" newer_than:30d -in:chats"
  );
});

test("addLookbackToQuery keeps explicit date constraints", () => {
  assert.equal(
    _internals.addLookbackToQuery("voucher after:2026/01/01 -in:chats", 30),
    "voucher after:2026/01/01 -in:chats"
  );
});

test("parseGenericVoucherEmail handles iShop table-style vouchers", () => {
  const card = _internals.parseGenericVoucherEmail(`
    Your Shopping Voucher order on iShop is successfully placed.
    Shopping Voucher(s) Purchased
    Description
    IKEA E-Voucher INR 1000
    Voucher Details
    Voucher Code: 6275982490003512750
    Pin: 2389
    Denomination: 1000.0
    Date of Expiry: 13 May 2027
  `);

  assert.deepEqual(card, {
    brand: "IKEA",
    amount: 1000,
    code: "6275982490003512750",
    pin: "2389",
    expiryDate: "2027-05-13",
  });
});

test("parseGenericVoucherEmail handles GyFTR mixed gift card and promo emails", () => {
  const card = _internals.parseGenericVoucherEmail(`
    Congratulations ! Thank you for buying Gift voucher from Gyftr via HDFC Bank Smartbuy.
    Swiggy Instamart
    E-Gift Card Code
    VOGRCCDFS3WNRFDDC
    Value
    5000
    PIN
    763845
    Valid Till
    24 Aug 2026
    Flower Aura Promo Code
    Promo Code
    FAPGY20BOCDB71E7
    Promo Code Details
    Flat 20% off On MOV 699
  `);

  assert.deepEqual(card, {
    brand: "Swiggy Instamart",
    amount: 5000,
    code: "VOGRCCDFS3WNRFDDC",
    pin: "763845",
    expiryDate: "2026-08-24",
  });
});

test("parseGenericVoucherEmail handles Maximize gift card details", () => {
  const card = _internals.parseGenericVoucherEmail(`
    Maximize
    Your Gift Card Details
    HP Pay (INR 5000)
    ₹5000.00
    E-Gift Card Number
    1981960692324135
    PIN
    HPVG661269634215
  `);

  assert.deepEqual(card, {
    brand: "HP Pay",
    amount: 5000,
    code: "1981960692324135",
    pin: "HPVG661269634215",
    expiryDate: null,
  });
});

test("parseGenericVoucherEmail accepts cards without pin or expiry", () => {
  const card = _internals.parseGenericVoucherEmail(`
    Your Gift Card Details
    BigBasket Gift Card INR 1500
    E-Gift Card Number
    BBGC123456789
    Value
    1500
  `);

  assert.deepEqual(card, {
    brand: "BigBasket",
    amount: 1500,
    code: "BBGC123456789",
    pin: null,
    expiryDate: null,
  });
});

test("parseGiftCardFromEmailText does not exclude mixed gift card and promo emails", async () => {
  const result = await _internals.parseGiftCardFromEmailText(`
    Gift voucher details
    Swiggy Instamart
    E-Gift Card Code
    VOGRCCDFS3WNRFDDC
    Value
    5000
    PIN
    763845
    Valid Till
    24 Aug 2026
    Promo Code
    FAPGY20BOCDB71E7
    Flat 20% off
  `);

  assert.equal(result.mode, "generic");
  assert.equal(result.card.brand, "Swiggy Instamart");
  assert.equal(result.card.code, "VOGRCCDFS3WNRFDDC");
});

test("parseGiftCardFromEmailText excludes Amazon Pay refund balance credits", async () => {
  const result = await _internals.parseGiftCardFromEmailText(`
    Dear Customer,
    Refund for your Amazon.in Order has been applied to your Amazon Pay balance.
    Received
    Amazon Pay eGift Card
    Amount
    ₹33.00
    Reference ID
    6014884129172953
    Order Number
    111eCAFTEng4uqMgpF8TQzi.1
    Expiry date
    26-May-2027
    Issued by
    Pine Labs Private Limited
    View Statement
    Add Money
  `);

  assert.equal(result.mode, "excluded");
  assert.equal(result.card, null);
});
