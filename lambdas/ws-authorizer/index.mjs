// ============================================================================
//  ws-authorizer  (API Gateway WebSocket $connect authorizer)
// ----------------------------------------------------------------------------
//  Verifies the short-lived JWT passed as ?token=<jwt> on $connect.
//
//  VAPT closures in this file:
//    - Finding 5: structured JSON logging on ALL paths, including denies.
//      Previously the deny path returned silently — auditor flagged this as
//      "zero audit trail for auth failures".
//
//  Env vars:
//    JWT_SIGNING_KEY  must match ws-token-issuer's signing key
// ============================================================================
import crypto from "node:crypto";

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

function verifyJwt(token, key) {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, sig] = parts;
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${h}.${p}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

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
      Statement: [
        { Action: "execute-api:Invoke", Effect: "Allow", Resource: resource },
      ],
    },
    context: context || {},
  };
}

function deny(resource) {
  return {
    principalId: "unauthorized",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Action: "execute-api:Invoke", Effect: "Deny", Resource: resource },
      ],
    },
  };
}

export const handler = async (event) => {
  const sourceIp =
    (event.requestContext && event.requestContext.identity &&
      event.requestContext.identity.sourceIp) ||
    "unknown";
  const resource = event.methodArn;

  const key = process.env.JWT_SIGNING_KEY;
  if (!key) {
    log("error", "authorizer_misconfigured", { sourceIp, reason: "no_signing_key" });
    return deny(resource);
  }

  const token =
    (event.queryStringParameters && event.queryStringParameters.token) || "";
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
