const SENSITIVE_KEY_PATTERN =
  /(token|secret|key|password|pin|authorization|cookie)/i;
const SECRET_VALUE_PATTERNS = [
  /bot\d+:[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

// Logs are public-operational surface area, so redact by field name and by
// common token shapes before writing structured JSON.
function redactString(value) {
  return SECRET_VALUE_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, "[REDACTED]"),
    value,
  );
}

function redact(value, key = "") {
  if (value == null) {
    return value;
  }

  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  return redact({
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    details: error.details,
    hint: error.hint,
  });
}

function write(level, message, meta = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message: redactString(message),
    ...redact(meta),
  });

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

function logInfo(message, meta) {
  write("info", message, meta);
}

function logWarn(message, meta) {
  write("warn", message, meta);
}

function logError(message, error, meta = {}) {
  write("error", message, {
    ...meta,
    error: serializeError(error),
  });
}

module.exports = {
  logError,
  logInfo,
  logWarn,
};
