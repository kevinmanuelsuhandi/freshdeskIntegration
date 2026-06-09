// ============================================================================
//  onboard-tenant  (Lambda Function URL)
// ----------------------------------------------------------------------------
//  Admin endpoint to manage tenant secrets in Parameter Store.
//
//  Auth: Authorization: Bearer <onboardingApiKey>
//
//  Compensating controls (because of static admin key):
//    1. Long random admin key, stored only in Parameter Store + password manager.
//    2. In-handler rate limit: 10 req/min per source IP.
//    3. Structured logging on every auth failure → CloudWatch alarm.
//
//  Tenant secrets managed (2 per tenant):
//    - wsSendSecret    (Hoiio → ws-send)
//    - issuerApiKey    (Frontend → ws-token-issuer)
// ============================================================================
import crypto from "node:crypto";
import {
  SSMClient,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  DeleteParametersCommand,
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const ADMIN_KEY_PARAM = "/freshdesk/internal/onboardingApiKey";
const TENANTS_PREFIX = "/freshdesk/tenants/";
const SECRET_NAMES = ["wsSendSecret", "issuerApiKey"];

let adminKeyCache = { value: null, expiresAt: 0 };

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const requestHistory = new Map();

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

function rateLimited(sourceIp) {
  const now = Date.now();
  const arr = (requestHistory.get(sourceIp) || []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  arr.push(now);
  requestHistory.set(sourceIp, arr);
  return arr.length > RATE_MAX;
}

async function getAdminKey() {
  if (adminKeyCache.value && Date.now() < adminKeyCache.expiresAt) {
    return adminKeyCache.value;
  }
  const res = await ssm.send(
    new GetParameterCommand({ Name: ADMIN_KEY_PARAM, WithDecryption: true })
  );
  adminKeyCache = { value: res.Parameter.Value, expiresAt: Date.now() + 60_000 };
  return adminKeyCache.value;
}

async function upsertTenant(domain, secrets) {
  for (const name of SECRET_NAMES) {
    if (typeof secrets[name] !== "string" || secrets[name].length === 0) {
      throw new Error(`secrets.${name} required (non-empty string)`);
    }
    await ssm.send(
      new PutParameterCommand({
        Name: `${TENANTS_PREFIX}${domain}/${name}`,
        Value: secrets[name],
        Type: "SecureString",
        Overwrite: true,
      })
    );
  }
}

async function removeTenant(domain) {
  const names = SECRET_NAMES.map((n) => `${TENANTS_PREFIX}${domain}/${n}`);
  await ssm.send(new DeleteParametersCommand({ Names: names }));
}

async function listTenants() {
  const domains = new Set();
  let nextToken;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: TENANTS_PREFIX,
        Recursive: true,
        NextToken: nextToken,
      })
    );
    for (const p of res.Parameters || []) {
      const rest = p.Name.slice(TENANTS_PREFIX.length);
      const domain = rest.split("/")[0];
      if (domain) domains.add(domain);
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return [...domains];
}

export const handler = async (event) => {
  const sourceIp =
    (event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp) || "unknown";

  if (rateLimited(sourceIp)) {
    log("warn", "onboard_rate_limited", { sourceIp });
    return reply(429, { error: "too many requests" });
  }

  let expectedKey;
  try {
    expectedKey = await getAdminKey();
  } catch (err) {
    log("error", "onboard_misconfigured", {
      sourceIp,
      reason: "cannot_load_admin_key",
      error: err && err.name ? err.name : "unknown",
    });
    return reply(500, { error: "server misconfigured" });
  }
  const provided = extractBearer(event.headers || {});
  if (!secretMatches(provided, expectedKey)) {
    log("warn", "onboard_auth_denied", { sourceIp });
    return reply(401, { error: "unauthorized" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    log("warn", "onboard_bad_json", { sourceIp });
    return reply(400, { error: "invalid json" });
  }

  const action = body.action;
  try {
    if (action === "list") {
      const tenants = await listTenants();
      log("info", "onboard_list", { sourceIp, count: tenants.length });
      return reply(200, { tenants });
    }

    if (typeof body.freshdeskDomain !== "string" || !HOST_RE.test(body.freshdeskDomain)) {
      return reply(400, { error: "freshdeskDomain required (valid hostname)" });
    }

    if (action === "upsert") {
      if (!body.secrets || typeof body.secrets !== "object") {
        return reply(400, { error: "secrets object required" });
      }
      try {
        await upsertTenant(body.freshdeskDomain, body.secrets);
      } catch (err) {
        return reply(400, { error: err.message });
      }
      log("info", "onboard_upsert", { sourceIp, freshdeskDomain: body.freshdeskDomain });
      return reply(200, { status: "upserted", freshdeskDomain: body.freshdeskDomain });
    }

    if (action === "remove") {
      await removeTenant(body.freshdeskDomain);
      log("info", "onboard_remove", { sourceIp, freshdeskDomain: body.freshdeskDomain });
      return reply(200, { status: "removed", freshdeskDomain: body.freshdeskDomain });
    }

    return reply(400, { error: "action must be upsert|remove|list" });
  } catch (err) {
    log("error", "onboard_failed", {
      sourceIp,
      action,
      error: err && err.name ? err.name : "unknown",
    });
    return reply(500, { error: "internal" });
  }
};
