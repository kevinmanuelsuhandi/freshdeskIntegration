// ============================================================================
//  ws-token-issuer  (Lambda Function URL, auth: NONE)
// ----------------------------------------------------------------------------
//  Issues a short-lived (60s) JWT used by the frontend to open the WebSocket.
//  Called via the Freshworks Request method, so the per-tenant secret is
//  injected into the X-API-Key header by the platform.
//
//  Security:
//    - VAPT Finding 2 (mitigation): userEmail must pass a format check; the
//      previous `userEmail || "unknown"` fallback is removed. This raises the
//      bar — random/blank impersonation no longer works. Full closure of
//      impersonation requires cross-checking the email against Freshdesk's
//      agent list (Option 3 in the design notes); not implemented here.
//    - VAPT Finding 4: schema-shape validation on body before logic.
//    - VAPT Finding 5: structured JSON logging on all branches.
//
//  Env vars:
//    TENANT_CONFIGS   JSON: { "<domain>": { "token": "<tenant secret>" }, ... }
//    JWT_SIGNING_KEY  random long string used to sign/verify the short JWT
// ============================================================================
import crypto from "node:crypto";

const TOKEN_TTL_SECONDS = 60;

// Pragmatic email regex: not RFC-perfect, but rejects the obvious cases
// (empty, no @, no dot, whitespace, control chars) that the VAPT cares about.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hostname check (RFC 1123-ish) for freshdeskDomain.
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function log(level, event, fields = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    })
  );
}

function reply(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

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

// Constant-time comparison for the tenant secret.
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function validateInput(body) {
  if (!body || typeof body !== "object") return "invalid body";

  if (typeof body.freshdeskDomain !== "string" || body.freshdeskDomain.length > 255) {
    return "freshdeskDomain must be a string under 255 chars";
  }
  if (!HOST_RE.test(body.freshdeskDomain)) {
    return "freshdeskDomain has invalid format";
  }

  // userEmail is REQUIRED now — no fallback to "unknown".
  if (typeof body.userEmail !== "string" || body.userEmail.length === 0 || body.userEmail.length > 254) {
    return "userEmail required (string, 1-254 chars)";
  }
  if (!EMAIL_RE.test(body.userEmail)) {
    return "userEmail has invalid format";
  }

  return null;
}

export const handler = async (event) => {
  const sourceIp =
    (event.requestContext &&
      event.requestContext.http &&
      event.requestContext.http.sourceIp) ||
    "unknown";

  // --- Misconfiguration checks ---
  let tenantConfigs;
  try {
    tenantConfigs = JSON.parse(process.env.TENANT_CONFIGS || "{}");
  } catch {
    log("error", "issuer_misconfigured", { sourceIp, reason: "bad_tenant_configs" });
    return reply(500, { error: "server misconfigured" });
  }
  const signingKey = process.env.JWT_SIGNING_KEY;
  if (!signingKey) {
    log("error", "issuer_misconfigured", { sourceIp, reason: "no_signing_key" });
    return reply(500, { error: "server misconfigured" });
  }

  // --- Parse + validate body ---
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    log("warn", "issuer_bad_json", { sourceIp });
    return reply(400, { error: "invalid body" });
  }
  const validationError = validateInput(body);
  if (validationError) {
    log("warn", "issuer_validation_failed", { sourceIp, reason: validationError });
    return reply(400, { error: validationError });
  }

  // --- Verify per-tenant secret ---
  const tenant = tenantConfigs[body.freshdeskDomain];
  if (!tenant || !tenant.token) {
    log("warn", "issuer_unknown_tenant", { sourceIp, freshdeskDomain: body.freshdeskDomain });
    return reply(403, { error: "unknown tenant" });
  }

  const headers = event.headers || {};
  const apiKey = headers["x-api-key"] || headers["X-API-Key"] || "";
  if (!secretMatches(apiKey, tenant.token)) {
    log("warn", "issuer_bad_api_key", { sourceIp, freshdeskDomain: body.freshdeskDomain });
    return reply(401, { error: "unauthorized" });
  }

  // --- Issue the JWT ---
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: body.userEmail,                // already validated, no "unknown" fallback
    domain: body.freshdeskDomain,
    iat: now,
    nbf: now - 30,                      // clock-skew tolerance
    exp: now + TOKEN_TTL_SECONDS,
  };
  const token = signJwt(payload, signingKey);

  log("info", "issuer_token_issued", {
    sourceIp,
    freshdeskDomain: body.freshdeskDomain,
    sub: body.userEmail,
    ttl: TOKEN_TTL_SECONDS,
  });

  return reply(200, { token, expiresIn: TOKEN_TTL_SECONDS });
};
