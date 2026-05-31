function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    details: error.details,
    hint: error.hint,
  };
}

function write(level, message, meta = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
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
