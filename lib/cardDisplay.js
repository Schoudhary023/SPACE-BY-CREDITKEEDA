const { RUPEE, TRASH, WARNING } = require("./cardConstants");
const { escMd } = require("./markdown");
const DISPLAY_TIMEZONE = process.env.EXPIRY_REMINDER_TIMEZONE;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeBrandKey(brand) {
  return String(brand || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function getBrandEmoji(brand) {
  const key = normalizeBrandKey(brand);
  const brandRules = [
    { match: ["amazonpay", "amazonpayments", "amazonwallet"], emoji: "💳" },
    { match: ["amazonin", "amazonindia"], emoji: "🛒" },
    { match: ["amazon"], emoji: "🛒" },
    { match: ["flipkart"], emoji: "🛍️" },
    { match: ["myntra"], emoji: "👗" },
    { match: ["ajio"], emoji: "🧥" },
    { match: ["nykaa"], emoji: "💄" },
    { match: ["tatacliq"], emoji: "🛍️" },
    { match: ["reliancedigital"], emoji: "📱" },
    { match: ["croma"], emoji: "💻" },
    { match: ["swiggy"], emoji: "🍔" },
    { match: ["zomato"], emoji: "🍽️" },
    { match: ["uber"], emoji: "🚗" },
    { match: ["ola"], emoji: "🛺" },
    { match: ["bookmyshow"], emoji: "🎬" },
    { match: ["pvr"], emoji: "🍿" },
    { match: ["googleplay", "googleplaygiftcard"], emoji: "🎮" },
    { match: ["apple"], emoji: "🍎" },
    { match: ["steam"], emoji: "🎮" },
    { match: ["sonyliv"], emoji: "📺" },
    { match: ["netflix"], emoji: "🎥" },
    { match: ["bigbasket"], emoji: "🧺" },
  ];

  for (const rule of brandRules) {
    if (rule.match.includes(key)) {
      return rule.emoji;
    }
  }

  return "🎁";
}

function buildListIntro(cards, { includeRedeemed, searchTerm, showing, total }) {
  const displayTotal = total ?? cards.length;
  const displayShowing = showing ?? cards.length;
  const scope = searchTerm
    ? `Search results for *${escMd(searchTerm)}*`
    : includeRedeemed
      ? "All cards in your vault"
      : "Active cards only";

  const countLine = displayShowing < displayTotal
    ? `Showing *${escMd(displayShowing)}* of *${escMd(displayTotal)}* cards`
    : `Total: *${escMd(displayTotal)}* card${displayTotal === 1 ? "" : "s"}`;

  return [
    `✨ *Vault Overview*`,
    countLine,
    `Scope: ${scope}`,
    `Use the buttons below to copy, redeem, or delete`,
  ].join("\n");
}

function formatSavedDate(createdAt) {
  if (!createdAt) return "Unknown";
  const d = new Date(createdAt);
  return d.toLocaleDateString("en-IN", {
    timeZone: DISPLAY_TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatIsoDateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseIsoDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function formatDisplayDate(isoDate) {
  const value = String(isoDate || "").trim();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return value;
  }

  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function cardExpiryStatus(card) {
  if (!card.expiry_date || card.is_redeemed) return "active";
  const todayIso = formatIsoDateInTimeZone(new Date(), DISPLAY_TIMEZONE);
  const today = parseIsoDate(todayIso);
  const expiry = parseIsoDate(card.expiry_date);
  if (expiry < today) return "expired";
  if ((expiry - today) <= 7 * DAY_MS) return "expiring_soon";
  return "active";
}

function cardMessage(card, index, decryptedCode, decryptedPin) {
  const expiryStatus = cardExpiryStatus(card);
  const statusLabel = card.is_redeemed
    ? "✅ Redeemed"
    : expiryStatus === "expired"
      ? "❌ Expired"
      : expiryStatus === "expiring_soon"
        ? "⚠️ Nearing expiry"
        : "Active";
  const lines = [
    `*${escMd(index)}\\. ${getBrandEmoji(card.brand)} ${escMd(card.brand)}*`,
    `Amount: ${RUPEE}${escMd(card.amount)}`,
    `Expiry: ${card.expiry_date ? escMd(formatDisplayDate(card.expiry_date)) : "Not provided"}`,
    `Code: ${escMd(decryptedCode)}`,
    `PIN: ${decryptedPin ? escMd(decryptedPin) : "Not provided"}`,
    `Status: ${statusLabel} · Saved: ${escMd(formatSavedDate(card.created_at))}`,
  ];

  if (card.is_redeemed) {
    lines.push(`Already used, kept safely in your vault for reference\\.`);
  }

  return lines.join("\n");
}

function buildCardKeyboard(card, decryptedCode, decryptedPin) {
  const rows = [
    [
      {
        text: "Copy code",
        copy_text: { text: decryptedCode },
      },
    ],
  ];

  if (decryptedPin) {
    rows[0].push({
      text: "Copy PIN",
      copy_text: { text: decryptedPin },
    });
  }

  const actionRow = [
    {
      text: "✅ Redeemed",
      callback_data: `mark_redeemed:${card.id}`,
    },
    {
      text: `${TRASH} Delete`,
      callback_data: `delete:${card.id}`,
    },
  ];

  if (card.is_redeemed) {
    actionRow.shift();
  }

  rows.push(actionRow);
  return rows;
}

function saveConfirmationMessage(parsedCards) {
  const count = parsedCards.length;
  const header = count === 1
    ? `🔍 *Please verify before saving:*`
    : `🔍 *Please verify before saving \\(${escMd(count)} cards\\):*`;

  const cardBlocks = parsedCards.map((parsed, i) => {
    const emoji = getBrandEmoji(parsed.brand);
    if (count === 1) {
      return [
        `${emoji} *${escMd(parsed.brand)}*`,
        `Amount: ${RUPEE}${escMd(parsed.amount)}`,
        `Code: \`${parsed.code}\``,
        parsed.pin ? `PIN: \`${parsed.pin}\`` : `PIN: Not provided`,
        `Expires: ${parsed.expiryDate ? escMd(formatDisplayDate(parsed.expiryDate)) : "Not provided"}`,
      ].join("\n");
    }
    return [
      `*${escMd(i + 1)}\\.* ${emoji} *${escMd(parsed.brand)}* \\— ${RUPEE}${escMd(parsed.amount)}`,
      `Code: \`${parsed.code}\`${parsed.pin ? `  PIN: \`${parsed.pin}\`` : ""}`,
      `Expires: ${parsed.expiryDate ? escMd(formatDisplayDate(parsed.expiryDate)) : "Not provided"}`,
    ].join("\n");
  });

  const saveLabel = count === 1 ? "✅ Save" : `✅ Save All (${count})`;

  return {
    text: [header, ...cardBlocks].join("\n\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: saveLabel, callback_data: "confirm_save" },
          { text: "❌ Cancel", callback_data: "cancel_save" },
        ],
      ],
    },
  };
}

function deleteConfirmationMessage(cardId) {
  return {
    text: `${WARNING} Confirm delete?`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, delete", callback_data: `confirm_delete:${cardId}` },
          { text: "Cancel", callback_data: `cancel_delete:${cardId}` },
        ],
      ],
    },
  };
}

function deleteAllConfirmationMessage(cardCount) {
  return {
    text: `${WARNING} Delete all ${escMd(cardCount)} gift cards? This cannot be undone.`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, delete all", callback_data: "confirm_delete_all" },
          { text: "Cancel", callback_data: "cancel_delete_all" },
        ],
      ],
    },
  };
}

function deleteAccountConfirmationMessage(cardCount) {
  const detail = cardCount > 0
    ? `your account and all ${escMd(cardCount)} saved gift card${cardCount === 1 ? "" : "s"}`
    : `your account`;
  return {
    text: `${WARNING} This will permanently delete ${detail}\\. This cannot be undone\\.`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, delete my account", callback_data: "confirm_delete_account" },
          { text: "Cancel", callback_data: "cancel_delete_account" },
        ],
      ],
    },
  };
}

module.exports = {
  buildCardKeyboard,
  buildListIntro,
  cardMessage,
  deleteAccountConfirmationMessage,
  deleteAllConfirmationMessage,
  deleteConfirmationMessage,
  getBrandEmoji,
  formatDisplayDate,
  normalizeBrandKey,
  saveConfirmationMessage,
};
