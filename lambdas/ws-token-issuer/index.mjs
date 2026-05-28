// ============================================================================
//  ws-token-issuer  (Lambda Function URL, auth: NONE)
// ----------------------------------------------------------------------------
//  Issues a short-lived (60s) JWT that the frontend uses to open the WebSocket.
//  The frontend calls this via the Freshworks Request method (invokeTemplate),
//  so the per-tenant secret is injected into the X-API-Key header by the
//  platform and never appears in the browser.
//
//  Validation layers:
//    1. X-API-Key must match the secret configured for the claimed tenant.
//    2. freshdeskDomain must exist in TENANT_CONFIGS.
//
//  The issued JWT is signed with JWT_SIGNING_KEY (lives only in Lambda; NOT a
//  tenant secret, NOT exposed to the browser). The WebSocket authorizer
//  verifies this signature + expiry.
//
//  Env vars:
//    TENANT_CONFIGS   JSON: { "<domain>": { "token": "<tenant secret>" }, ... }
//    JWT_SIGNING_KEY  random long string used to sign/verify the short JWT
// ============================================================================
import crypto from "node:crypto";

const TOKEN_TTL_SECONDS = 60;

// --- Minimal HS256 JWT (no external dependency) ---
function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(payload, key) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = crypto
    .createHmac("sha256", key)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${sig}`;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  let tenantConfigs;
  try {
    tenantConfigs = JSON.parse(process.env.TENANT_CONFIGS || "{}");
  } catch {
    console.error("TENANT_CONFIGS is not valid JSON");
    return json(500, { error: "server misconfigured" });
  }
  const signingKey = process.env.JWT_SIGNING_KEY;
  if (!signingKey) {
    console.error("JWT_SIGNING_KEY missing");
    return json(500, { error: "server misconfigured" });
  }

  // --- Parse body ---
  const headers = event.headers || {};
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid body" });
  }
  const { freshdeskDomain, userEmail } = body;
  if (!freshdeskDomain) {
    return json(400, { error: "freshdeskDomain required" });
  }

  // --- Layer 2: tenant must be known ---
  const tenant = tenantConfigs[freshdeskDomain];
  if (!tenant) {
    console.warn("Unknown tenant:", freshdeskDomain);
    return json(403, { error: "unknown tenant" });
  }

  // --- Layer 1: per-tenant secret must match ---
  const apiKey = headers["x-api-key"] || headers["X-API-Key"] || "";
  if (!tenant.token || apiKey !== tenant.token) {
    console.warn("Bad API key for tenant:", freshdeskDomain);
    return json(401, { error: "unauthorized" });
  }

  // --- Issue short-lived JWT ---
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userEmail || "unknown",
    domain: freshdeskDomain,
    iat: now,
    nbf: now - 30, // clock-skew tolerance
    exp: now + TOKEN_TTL_SECONDS,
  };
  const token = signJwt(payload, signingKey);

  return json(200, { token, expiresIn: TOKEN_TTL_SECONDS });
};