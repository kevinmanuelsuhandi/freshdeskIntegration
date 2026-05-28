// ws-action-call Lambda (Node.js 20.x)
// Multi-tenant, self-contained, with API key check.
//
// Frontend payload:
//   { userId, userEmail, phoneNumber, freshdeskDomain, state }
//
// Header X-API-Key must match SHARED_SECRET env var.

const SHARED_SECRET = process.env.API_SHARED_SECRET;

let cachedConfigs = null;

function loadConfigs() {
  if (cachedConfigs) return cachedConfigs;
  const raw = process.env.TENANT_CONFIGS;
  if (!raw) throw new Error("TENANT_CONFIGS env var not set");
  try {
    cachedConfigs = JSON.parse(raw);
    return cachedConfigs;
  } catch (err) {
    throw new Error("TENANT_CONFIGS invalid JSON: " + err.message);
  }
}

function getTenantConfig(freshdeskDomain) {
  if (!freshdeskDomain || typeof freshdeskDomain !== "string") {
    throw new Error("freshdeskDomain is required");
  }
  const normalized = freshdeskDomain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const configs = loadConfigs();
  const config = configs[normalized];
  if (!config) throw new Error("Unknown tenant: " + normalized);
  if (!config.token || !config.callEndpoint) {
    throw new Error("Tenant config incomplete (missing token or callEndpoint): " + normalized);
  }
  return config;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
};

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  // API key check
  if (!SHARED_SECRET) {
    console.error("API_SHARED_SECRET not configured");
    return respond(500, { error: "Server misconfigured" });
  }
  const providedKey =
    event.headers?.["x-api-key"] || event.headers?.["X-API-Key"];
  if (providedKey !== SHARED_SECRET) {
    return respond(401, { error: "Unauthorized" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON" });
  }

  const { userId, userEmail, phoneNumber, freshdeskDomain, state } = body;

  if (!userId || !userEmail || !phoneNumber || !freshdeskDomain) {
    return respond(400, {
      error: "Missing required fields: userId, userEmail, phoneNumber, freshdeskDomain",
    });
  }

  let tenant;
  try {
    tenant = getTenantConfig(freshdeskDomain);
  } catch (err) {
    console.warn("Tenant lookup failed:", err.message);
    return respond(403, { error: "Unknown or unauthorized tenant" });
  }

  try {
    const hoiioRes = await fetch(tenant.callEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tenant.token}`,
      },
      body: JSON.stringify({
        userId,
        userEmail,
        phoneNumber,
        state: state || "clickToCall",
      }),
    });

    const text = await hoiioRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!hoiioRes.ok) {
      console.error("Hoiio call rejected:", hoiioRes.status, text);
      return respond(hoiioRes.status, {
        error: "Hoiio rejected the request",
        details: data,
      });
    }

    return respond(200, { ok: true, hoiio: data });
  } catch (err) {
    console.error("ws-action-call error:", err);
    return respond(500, { error: "Internal error" });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
