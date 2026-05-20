function splitCardInput(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeAmountToken(value) {
  return String(value || "")
    .replace(/,/g, "")
    .replace(/^₹+/u, "")
    .replace(/^(rs\.?|inr)/i, "");
}

function parseAmountInput(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/,/g, "")
    .replace(/\p{Sc}/gu, "")
    .replace(/^(?:rs\.?|inr|rupees?)\s*/i, "")
    .trim();

  if (!/^\d+$/.test(cleaned)) {
    return null;
  }

  const amount = Number(cleaned);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function isExpirySkipInput(value) {
  return /^(?:skip|no|none|na|n\/a)$/i.test(String(value || "").trim());
}

function parseMissingCardDetailsInput(
  text,
  { needsAmount = false, needsExpiry = false } = {},
) {
  const value = String(text || "").trim();

  if (!needsAmount && !needsExpiry) {
    return { amount: null, expiryDate: null, skippedExpiry: false };
  }

  if (!value) {
    return null;
  }

  if (needsAmount && needsExpiry) {
    const parts = value.split(/\s+/).filter(Boolean);

    for (let splitIndex = 1; splitIndex <= parts.length; splitIndex += 1) {
      const amount = parseAmountInput(parts.slice(0, splitIndex).join(" "));
      if (!amount) {
        continue;
      }

      const expiryText = parts.slice(splitIndex).join(" ").trim();
      if (!expiryText) {
        return { amount, expiryDate: null, skippedExpiry: false };
      }

      if (isExpirySkipInput(expiryText)) {
        return { amount, expiryDate: null, skippedExpiry: true };
      }

      const expiryDate = normalizeExpiryDate(expiryText);
      if (expiryDate) {
        return { amount, expiryDate, skippedExpiry: false };
      }
    }

    return null;
  }

  if (needsAmount) {
    const amount = parseAmountInput(value);
    return amount ? { amount, expiryDate: null, skippedExpiry: false } : null;
  }

  if (isExpirySkipInput(value)) {
    return { amount: null, expiryDate: null, skippedExpiry: true };
  }

  const expiryDate = normalizeExpiryDate(value);
  return expiryDate ? { amount: null, expiryDate, skippedExpiry: false } : null;
}

const BRAND_MAX_LENGTH = 100;
const CODE_MAX_LENGTH = 200;
const INVALID_BRAND_PATTERN =
  /^(?:inr|rs|rupees?|amount|value|code|pin|voucher|gift|card|giftcard|evoucher|e-voucher)$/i;

function parseCardInput(text) {
  const parts = splitCardInput(text);

  if (parts.length < 3) {
    return null;
  }

  const [brand, amountRaw, code, ...rest] = parts;
  const amount = Number(normalizeAmountToken(amountRaw));

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  if (brand.length > BRAND_MAX_LENGTH || code.length > CODE_MAX_LENGTH) {
    return null;
  }

  let expiryDate = null;
  let pinParts = rest;

  for (let width = 3; width >= 1 && !expiryDate; width -= 1) {
    for (let index = rest.length - width; index >= 0; index -= 1) {
      const normalizedExpiry = normalizeExpiryDate(
        rest.slice(index, index + width).join(" "),
      );
      if (normalizedExpiry) {
        expiryDate = normalizedExpiry;
        pinParts = [...rest.slice(0, index), ...rest.slice(index + width)];
        break;
      }
    }
  }

  const pin = pinParts.join(" ").trim() || null;

  return {
    brand,
    amount,
    code,
    pin,
    expiryDate,
  };
}

function normalizeExpiryDate(rawValue) {
  const value = String(rawValue || "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const dayMonthYearMatch = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dayMonthYearMatch) {
    const day = Number(dayMonthYearMatch[1]);
    const month = Number(dayMonthYearMatch[2]);
    const year = Number(dayMonthYearMatch[3]);

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      ) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }

  const namedMonthMatch = value.match(
    /^(\d{1,2})(?:st|nd|rd|th)?[\s/-]+([a-z]{3,9})[\s/-]+(\d{4})$/i,
  );
  if (namedMonthMatch) {
    const day = Number(namedMonthMatch[1]);
    const monthName = namedMonthMatch[2].toLowerCase();
    const year = Number(namedMonthMatch[3]);
    const monthNames = {
      jan: 1,
      january: 1,
      feb: 2,
      february: 2,
      mar: 3,
      march: 3,
      apr: 4,
      april: 4,
      may: 5,
      jun: 6,
      june: 6,
      jul: 7,
      july: 7,
      aug: 8,
      august: 8,
      sep: 9,
      sept: 9,
      september: 9,
      oct: 10,
      october: 10,
      nov: 11,
      november: 11,
      dec: 12,
      december: 12,
    };
    const month = monthNames[monthName];

    if (month && day >= 1 && day <= 31) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      ) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }

  const monthYearMatch = value.match(/^(\d{2})\/(\d{2,4})$/);
  if (monthYearMatch) {
    const month = Number(monthYearMatch[1]);
    const yearRaw = monthYearMatch[2];
    const year =
      yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);

    if (month >= 1 && month <= 12) {
      const date = new Date(Date.UTC(year, month, 0));
      const lastDay = String(date.getUTCDate()).padStart(2, "0");
      return `${year}-${String(month).padStart(2, "0")}-${lastDay}`;
    }
  }

  return null;
}

function sanitizeParsedCard(parsed, options = {}) {
  if (!parsed) {
    return null;
  }

  const minConfidence =
    typeof options.minConfidence === "number" ? options.minConfidence : 0.85;

  const requireAmount = options.requireAmount !== false;
  const amountMissing =
    parsed.amount == null || String(parsed.amount).trim() === "";
  const amount = amountMissing ? null : Number(parsed.amount);
  const hasValidAmount = Number.isFinite(amount) && amount > 0;
  const expiryDate = parsed.expiryDate
    ? normalizeExpiryDate(parsed.expiryDate)
    : null;
  const pin = parsed.pin == null ? null : String(parsed.pin).trim();

  if (
    !parsed.brand ||
    (requireAmount && !hasValidAmount) ||
    (!amountMissing && !hasValidAmount) ||
    !parsed.code ||
    !parsed.code.trim()
  ) {
    return null;
  }

  if (parsed.expiryDate && !expiryDate) {
    return null;
  }

  if (
    typeof parsed.confidence === "number" &&
    parsed.confidence < minConfidence
  ) {
    return null;
  }

  const brand = String(parsed.brand).trim();
  const code = String(parsed.code).trim();

  if (brand.length > BRAND_MAX_LENGTH || code.length > CODE_MAX_LENGTH) {
    return null;
  }

  if (INVALID_BRAND_PATTERN.test(brand)) {
    return null;
  }

  return {
    brand,
    amount: hasValidAmount ? amount : null,
    code,
    pin: pin || null,
    expiryDate,
  };
}

function sanitizeParsedCards(cards, options) {
  if (!Array.isArray(cards)) return [];
  return cards.map((card) => sanitizeParsedCard(card, options)).filter(Boolean);
}

module.exports = {
  normalizeExpiryDate,
  parseAmountInput,
  parseCardInput,
  parseMissingCardDetailsInput,
  sanitizeParsedCard,
  sanitizeParsedCards,
};
