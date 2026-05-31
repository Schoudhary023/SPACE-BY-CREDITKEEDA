const http = require("http");
const { supabase } = require("./supabase");

const HEALTH_TOKEN = process.env.HEALTH_TOKEN || "";
const HEALTH_BIND_ADDRESS = process.env.HEALTH_BIND_ADDRESS || "127.0.0.1";
const customRoutes = new Map();

const state = {
  startedAt: new Date().toISOString(),
  shuttingDown: false,
  telegramPolling: false,
  lastErrorAt: null,
};

function setHealthState(patch) {
  Object.assign(state, patch);
}

function getHealthSnapshot() {
  return {
    ok: !state.shuttingDown,
    ...state,
  };
}

let dbHealthCache = { ok: true, expiresAt: 0 };

async function checkDatabaseHealth() {
  const now = Date.now();
  if (now < dbHealthCache.expiresAt) {
    return dbHealthCache.ok;
  }

  let ok;
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 3000)
    );
    const query = supabase.from("users_vault").select("telegram_id").limit(1).maybeSingle();
    const { error } = await Promise.race([query, timeout]);
    ok = !error;
  } catch {
    ok = false;
  }

  dbHealthCache = { ok, expiresAt: now + 15000 };
  return ok;
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const customRoute = customRoutes.get(requestUrl.pathname);
  if (customRoute) {
    const handled = await customRoute(req, res, requestUrl);
    if (handled) {
      return;
    }
  }

  if (HEALTH_TOKEN) {
    const providedToken = req.headers["x-health-token"];
    if (providedToken !== HEALTH_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
  }

  if (requestUrl.pathname === "/health" || requestUrl.pathname === "/ready") {
    const dbOk = await checkDatabaseHealth();
    const snapshot = getHealthSnapshot();
    const ok = !state.shuttingDown && dbOk;
    const body = JSON.stringify({ ...snapshot, ok, dbOk });
    const statusCode = ok ? 200 : 503;

    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
}

function startHealthServer(port) {
  if (!port) {
    return null;
  }

  const server = http.createServer(handleRequest);
  server.listen(port, HEALTH_BIND_ADDRESS);
  return server;
}

function registerHttpRoute(pathname, handler) {
  customRoutes.set(pathname, handler);
}

module.exports = {
  registerHttpRoute,
  setHealthState,
  startHealthServer,
};
