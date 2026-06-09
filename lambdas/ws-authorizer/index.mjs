// ============================================================================
//  ws-authorizer  (API Gateway WebSocket $connect authorizer)
// ----------------------------------------------------------------------------
//  Verifies the short-lived JWT. The signing key now comes from Parameter
//  Store (same value the issuer uses to sign).
// ============================================================================
import crypto from "node:crypto";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const CACHE_TTL_MS = 5 * 60 * 1000;
const ssm = new SSMClient({});
let signingKeyCache = { value: null, expiresAt: 0 };

async function getSigningKey() {
  if (signingKeyCache.value && Date.now() < signingKeyCache.expiresAt) {
    return signingKeyCache.value;
  }
  const res = await ssm.send(
    new GetParameterCommand({
      Name: "/freshdesk/internal/jwtSigningKey",
      WithDecryption: true,
    })
  );
  signingKeyCache = {
    value: res.Parameter.Value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return signingKeyCache.value;
}

function log(level, event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

function verifyJwt(token, key) {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, sig] = parts;
  const expected = crypto.createHmac("sha256", key).update(`${h}.${p}`).digest("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return { ok: false, reason: "expired" };
  if (payload.nbf && now < payload.nbf) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, payload };
}

function allow(principalId, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: resource }],
    },
    context: context || {},
  };
}

function deny(resource) {
  return {
    principalId: "unauthorized",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Deny", Resource: resource }],
    },
  };
}

export const handler = async (event) => {
  const sourceIp =
    (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || "unknown";
  const resource = event.methodArn;

  let key;
  try {
    key = await getSigningKey();
  } catch (err) {
    log("error", "authorizer_misconfigured", {
      sourceIp,
      reason: "cannot_load_signing_key",
      error: err && err.name ? err.name : "unknown",
    });
    return deny(resource);
  }

  const token = (event.queryStringParameters && event.queryStringParameters.token) || "";
  if (!token) {
    log("warn", "authorizer_denied", { sourceIp, reason: "missing_token" });
    return deny(resource);
  }
  const result = verifyJwt(token, key);
  if (!result.ok) {
    log("warn", "authorizer_denied", { sourceIp, reason: result.reason });
    return deny(resource);
  }

  log("info", "authorizer_allowed", {
    sourceIp,
    sub: result.payload.sub,
    domain: result.payload.domain,
  });
  return allow(result.payload.sub || "agent", resource, {
    agentEmail: result.payload.sub || "",
    freshdeskDomain: result.payload.domain || "",
  });
};