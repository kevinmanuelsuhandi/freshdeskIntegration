// ============================================================================
//  ws-authorizer  (API Gateway WebSocket $connect authorizer)
// ----------------------------------------------------------------------------
//  Verifies the short-lived JWT passed as ?token=<jwt> on $connect.
//  Replaces the old static-secret check. A leaked token is useless after 60s.
//
//  Env vars:
//    JWT_SIGNING_KEY  must match ws-token-issuer's signing key
// ============================================================================
import crypto from "node:crypto";

function verifyJwt(token, key) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${h}.${p}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  // Constant-time comparison to avoid timing attacks.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return null; // expired
  if (payload.nbf && now < payload.nbf) return null; // not yet valid
  return payload;
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
  const key = process.env.JWT_SIGNING_KEY;
  const resource = event.methodArn;

  const token =
    (event.queryStringParameters && event.queryStringParameters.token) || "";
  if (!token || !key) {
    return deny(resource);
  }

  const payload = verifyJwt(token, key);
  if (!payload) {
    return deny(resource);
  }

  // Pass verified identity to downstream routes via the authorizer context.
  return allow(payload.sub || "agent", resource, {
    agentEmail: payload.sub || "",
    freshdeskDomain: payload.domain || "",
  });
};
