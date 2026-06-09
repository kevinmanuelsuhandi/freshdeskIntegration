// ============================================================================
//  ws-token-issuer  (Lambda Function URL)
// ----------------------------------------------------------------------------
//  Frontend calls this via Freshworks Request method to obtain a 60s JWT.
//  Per-tenant secret (issuerApiKey) from Parameter Store, sent in standard
//  `Authorization: Bearer <token>` header.
// ============================================================================
import crypto from "node:crypto";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const TOKEN_TTL_SECONDS = 60;
const CACHE_TTL_MS = 5 * 60 * 1000;

const ssm = new SSMClient({});
const cache = new Map();

async function getSecret(name) {
  const hit = cache.get(name);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true })
    );
    cache.set(name, { value: res.Parameter.Value, expiresAt: Date.now() + CACHE_TTL_MS });
    return res.Parameter.Value;
  } catch (err) {
    if (err && err.name === "ParameterNotFound") return null;
    throw err;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function log(level, event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

function reply(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signJwt(payload, key) {
  const header = { alg: "HS256", typ: "JWT" };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac("sha256", key).update(data).digest("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${data}.${sig}`;
}

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractBearer(headers) {
  const raw = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

function validateInput(body) {
  if (!body || typeof body !== "object") return "invalid body";
  if (typeof body.freshdeskDomain !== "string" || body.freshdeskDomain.length > 255) return "freshdeskDomain must be a string under 255 chars";
  if (!HOST_RE.test(body.freshdeskDomain)) return "freshdeskDomain has invalid format";
  if (typeof body.userEmail !== "string" || body.userEmail.length === 0 || body.userEmail.length > 254) return "userEmail required";
  if (!EMAIL_RE.test(body.userEmail)) return "userEmail has invalid format";
  return null;
}

export const handler = async (event) => {
  const sourceIp =
    (event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp) || "unknown";

  const signingKey = await getSecret("/freshdesk/internal/jwtSigningKey");
  if (!signingKey) {
    log("error", "issuer_misconfigured", { sourceIp, reason: "no_signing_key" });
    return reply(500, { error: "server misconfigured" });
  }

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

  const tenantApiKey = await getSecret(
    `/freshdesk/tenants/${body.freshdeskDomain}/issuerApiKey`
  );
  const provided = extractBearer(event.headers || {});

  // Uniform 401 for both unknown-tenant and bad-key (closes Finding 5).
  if (!tenantApiKey || !secretMatches(provided, tenantApiKey)) {
    log("warn", "issuer_auth_denied", {
      sourceIp,
      reason: tenantApiKey ? (provided ? "bad_api_key" : "missing_bearer") : "unknown_tenant",
      freshdeskDomain: body.freshdeskDomain,
    });
    return reply(401, { error: "unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: body.userEmail,
    domain: body.freshdeskDomain,
    iat: now,
    nbf: now - 30,
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
