const { supabase } = require("../lib/supabase");

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function requireSupabaseUser(req) {
  const token = getBearerToken(req);

  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      error: "Missing bearer token",
    };
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return {
      ok: false,
      statusCode: 401,
      error: "Invalid bearer token",
    };
  }

  return {
    ok: true,
    user: data.user,
  };
}

module.exports = {
  getBearerToken,
  requireSupabaseUser,
};
