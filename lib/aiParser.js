const vertexApiKey = process.env.VERTEX_API_KEY;
const vertexTextModel =
  process.env.VERTEX_AI_MODEL || "gemini-3.1-flash-lite-preview";
const vertexImageModel =
  process.env.VERTEX_AI_IMAGE_MODEL ||
  vertexTextModel ||
  "gemini-3-flash-preview";
const aiParsingEnv = String(process.env.AI_PARSING_ENABLED || "").toLowerCase();
const aiParsingEnabled = aiParsingEnv === "true";

const cardItemSchema = {
  type: "object",
  properties: {
    brand: {
      type: ["string", "null"],
      description: "Gift card brand or merchant name. Use null if unclear.",
    },
    amount: {
      type: ["number", "null"],
      description: "Gift card amount as a number. Use null if unclear.",
    },
    code: {
      type: ["string", "null"],
      description: "Gift card code or claim code. Use null if unclear.",
    },
    pin: {
      type: ["string", "null"],
      description: "Gift card PIN or redemption code. Use null if absent.",
    },
    expiryDate: {
      type: ["string", "null"],
      description: "Expiry date in YYYY-MM-DD if visible, else null.",
    },
    confidence: { type: "number", description: "Confidence from 0 to 1." },
    notes: {
      type: "string",
      description: "Short note about missing or uncertain fields.",
    },
  },
  required: [
    "brand",
    "amount",
    "code",
    "pin",
    "expiryDate",
    "confidence",
    "notes",
  ],
};

// Single-card schema — used for text extraction
const singleCardSchema = cardItemSchema;

// Multi-card schema — used for image extraction
const multiCardSchema = {
  type: "object",
  properties: {
    cards: { type: "array", items: cardItemSchema },
  },
  required: ["cards"],
};

function isAiParsingEnabled() {
  return Boolean(vertexApiKey && aiParsingEnabled);
}

function buildVertexError(status, responseText) {
  const error = new Error(`Vertex AI API error: ${status} ${responseText}`);
  error.status = status;

  if (status === 429 || status === 503 || status === 504) {
    error.code = "VERTEX_UNAVAILABLE";
    return error;
  }

  if (status === 401) {
    error.code = "VERTEX_AUTH_ERROR";
    return error;
  }

  if (status === 403 && responseText.includes("BILLING_DISABLED")) {
    error.code = "VERTEX_BILLING_DISABLED";
    return error;
  }

  if (status === 403) {
    error.code = "VERTEX_AUTH_ERROR";
    return error;
  }

  if (status === 404) {
    error.code = "VERTEX_MODEL_NOT_FOUND";
    return error;
  }

  error.code = "VERTEX_API_ERROR";
  return error;
}

const singleCardInstructions = [
  "Extract one gift card from the provided input.",
  "Return strict JSON matching the schema.",
  "The input may be a natural language instruction, a pasted bank or wallet message, or a plain text gift card description.",
  "If the message describes a voucher or gift card purchase or storage action, extract the intended merchant, amount, code, PIN, and expiry when present.",
  "Handle bank SMS, WhatsApp, email, wallet, and receipt-style messages that mention gift cards, vouchers, claim codes, redemption codes, or merchant balances.",
  "Pick the actual gift card merchant or brand, not currency labels, not 'voucher', not sender names, and not aggregator platforms unless they are clearly the merchant.",
  "For example, in 'You have received Uber E-Voucher INR 1000 from iShop', the brand is Uber, not INR and not iShop.",
  "Ignore transaction IDs, reference numbers, masked cards, account numbers, UPI IDs, and unrelated banking metadata unless they are clearly the voucher code or PIN.",
  "Prefer voucher or redemption codes over payment reference numbers when both appear.",
  "Do not guess missing values.",
  "If brand, amount, or code is missing, partially visible, or uncertain, return null for that field.",
  "PIN and expiryDate are optional; return null when they are absent.",
  "Normalize expiryDate to YYYY-MM-DD when clearly available.",
  "Understand dates written in natural language such as '20th June 2026'.",
  "If only month and year are clearly visible, use the last day of that month.",
  "If brand, amount, or code is null, keep confidence low and explain why in notes.",
].join(" ");

const multiCardInstructions = [
  "Extract all gift cards visible in the image.",
  "Return a JSON object with a 'cards' array containing one entry per distinct gift card found.",
  "Do not guess missing values.",
  "Physical gift cards may show the merchant and scratch-panel gift card code without showing the amount.",
  "If the amount is not visible or identifiable, return amount as null; do not invent a denomination.",
  "For physical cards, prefer the text near labels such as 'Gift Card Code', 'Claim Code', or 'Voucher Code' as code.",
  "Ignore reference IDs, serial numbers, barcodes, QR payloads, transaction IDs, and support URLs unless they are clearly labeled as the gift card or claim code.",
  "If brand or code is missing, partially visible, or uncertain for a card, return null for that field.",
  "PIN and expiryDate are optional; return null when they are absent.",
  "Normalize expiryDate to YYYY-MM-DD when clearly available.",
  "If only month and year are clearly visible, use the last day of that month.",
  "If brand or code is null, keep confidence low and explain why in notes.",
  "If only amount is null but brand and code are clear, use confidence for the visible brand and code and note that amount is not visible.",
  "If no gift cards are found, return an empty array.",
].join(" ");

function getVertexModel(responseJsonSchema) {
  return responseJsonSchema === multiCardSchema
    ? vertexImageModel
    : vertexTextModel;
}

async function generateStructuredContent(parts, responseJsonSchema) {
  if (!vertexApiKey) {
    throw new Error("Vertex AI Express Mode parsing is not configured");
  }

  if (!aiParsingEnabled) {
    throw new Error("AI parsing is disabled unless AI_PARSING_ENABLED=true");
  }

  const vertexModel = getVertexModel(responseJsonSchema);

  if (!/^[\w.-]+$/.test(vertexModel)) {
    throw new Error("Invalid Vertex model format");
  }

  const endpoint = `https://aiplatform.googleapis.com/v1/publishers/google/models/${vertexModel}:generateContent`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": vertexApiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0,
        topP: 0.1,
        maxOutputTokens: responseJsonSchema === multiCardSchema ? 1000 : 400,
        responseMimeType: "application/json",
        responseJsonSchema,
      },
    }),
  });

  if (!response.ok) {
    throw buildVertexError(response.status, await response.text());
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const error = new Error(
      "Vertex AI response did not contain structured output",
    );
    error.code = "VERTEX_INVALID_RESPONSE";
    throw error;
  }

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const parseError = new Error(
      `Vertex AI returned unparseable JSON: ${err.message}`,
    );
    parseError.code = "VERTEX_INVALID_RESPONSE";
    throw parseError;
  }
}

async function extractGiftCardFromText(text) {
  return generateStructuredContent(
    [
      {
        text: [
          singleCardInstructions,
          "Examples:",
          "- 'add amazon voucher of value 1000 and code AAAA11111 with expiry 20th june 2026' => brand Amazon, amount 1000, code AAAA11111, expiry 2026-06-20.",
          "- 'Your Amazon Pay gift card worth Rs 500 has been added to your account. Claim code: ZXCV1234. Valid till 31 Dec 2026.' => brand Amazon, amount 500, code ZXCV1234, expiry 2026-12-31.",
          "- 'You have received Uber E-Voucher INR 1000 from iShop. Code: QYEDWZ4WA73RM Value: 1000 Valid Till: 28 Feb 2027 PIN: 6004910014703812' => brand Uber, amount 1000, code QYEDWZ4WA73RM, pin 6004910014703812, expiry 2027-02-28.",
          "",
          "Extract the gift card details from this message:",
          text,
        ].join("\n\n"),
      },
    ],
    singleCardSchema,
  );
}

async function extractGiftCardsFromImage({ imageBase64, mimeType, caption }) {
  const parts = [
    { text: multiCardInstructions },
    { inlineData: { mimeType, data: imageBase64 } },
  ];

  if (caption) {
    parts.push({ text: `The user also included this caption:\n${caption}` });
  }

  const result = await generateStructuredContent(parts, multiCardSchema);
  return Array.isArray(result.cards) ? result.cards : [];
}

module.exports = {
  extractGiftCardsFromImage,
  extractGiftCardFromText,
  isAiParsingEnabled,
};
