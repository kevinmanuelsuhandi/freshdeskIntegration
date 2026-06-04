// ============================================================================
//  ws-default  (API Gateway WebSocket $default route handler)
// ----------------------------------------------------------------------------
//  Handles inbound messages from the agent's WebSocket. Identity comes from
//  the AUTHORIZER CONTEXT (set by ws-authorizer after JWT verification) —
//  NOT from the message body. Even if the client lies about userEmail in the
//  payload, we use the verified value from authorizer context.
//
//  VAPT closures in this file:
//    - Finding 4: per-action schema validation on body fields before any
//      forward to Hoiio (userId/userName type + length capped).
//    - Finding 5: structured JSON logging on every action and on errors.
//
//  EXISTING: this skeleton handles "whoami" and "register" actions, which is
//  what your current frontend sends. If you have additional actions, add
//  validators + handlers using the same pattern.
//
//  Env vars:
//    TENANT_CONFIGS    JSON: { "<domain>": { "endpoint": "<url>", "token": "<secret>" }, ... }
// ============================================================================
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Per-action validators (Finding 4) ---
function validateRegister(body) {
  // userEmail in the body is OPTIONAL — the verified one comes from authorizer.
  // If sent, it must at least be well-formed (defensive).
  if (body.userEmail !== undefined) {
    if (typeof body.userEmail !== "string" || !EMAIL_RE.test(body.userEmail) || body.userEmail.length > 254) {
      return "userEmail (if provided) must be a valid email";
    }
  }
  if (body.userId !== undefined && body.userId !== null) {
    const s = String(body.userId);
    if (s.length === 0 || s.length > 64) return "userId must be 1-64 chars";
  }
  if (body.userName !== undefined && body.userName !== null) {
    if (typeof body.userName !== "string") return "userName must be a string";
    if (body.userName.length > 256) return "userName too long";
  }
  return null;
}

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const domainName = event.requestContext.domainName;
  const stage = event.requestContext.stage;

  // VERIFIED identity from authorizer (NOT from body — VAPT Finding 2 mitigation).
  const authorizer = (event.requestContext && event.requestContext.authorizer) || {};
  const verifiedEmail = authorizer.agentEmail || "";
  const verifiedDomain = authorizer.freshdeskDomain || "";

  let msg;
  try {
    msg = JSON.parse(event.body || "{}");
  } catch {
    log("warn", "default_bad_json", { connectionId });
    return { statusCode: 400, body: "invalid json" };
  }

  if (!msg || typeof msg !== "object" || typeof msg.action !== "string") {
    log("warn", "default_missing_action", { connectionId });
    return { statusCode: 400, body: "missing action" };
  }

  const mgmt = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });
  const push = (payload) =>
    mgmt.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload)),
      })
    );

  try {
    if (msg.action === "whoami") {
      await push({ type: "whoami", sessionId: connectionId });
      log("info", "default_whoami", { connectionId, sub: verifiedEmail });
      return { statusCode: 200, body: "ok" };
    }

    if (msg.action === "register") {
      const validationError = validateRegister(msg);
      if (validationError) {
        log("warn", "default_validation_failed", {
          connectionId,
          action: "register",
          reason: validationError,
        });
        await push({ type: "error", message: "invalid input" });
        return { statusCode: 400, body: "invalid input" };
      }

      // Load tenant config from VERIFIED domain.
      let tenantConfigs;
      try {
        tenantConfigs = JSON.parse(process.env.TENANT_CONFIGS || "{}");
      } catch {
        log("error", "default_misconfigured", { connectionId, reason: "bad_tenant_configs" });
        return { statusCode: 500, body: "misconfigured" };
      }
      const tenant = tenantConfigs[verifiedDomain];
      if (!tenant || !tenant.endpoint || !tenant.token) {
        log("warn", "default_unknown_tenant", {
          connectionId,
          freshdeskDomain: verifiedDomain,
        });
        return { statusCode: 403, body: "unknown tenant" };
      }

      // Forward to Hoiio using VERIFIED identity (not body.userEmail).
      try {
        const res = await fetch(tenant.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tenant.token}`,
          },
          body: JSON.stringify({
            sessionId: connectionId,
            userEmail: verifiedEmail,         // verified by authorizer
            userId: msg.userId || null,
            userName: msg.userName || null,
            freshdeskDomain: verifiedDomain,  // verified by authorizer
            state: "register",
            at: Date.now(),
          }),
        });
        if (!res.ok) {
          log("error", "default_register_upstream_failed", {
            connectionId,
            upstreamStatus: res.status,
          });
        }
      } catch (err) {
        log("error", "default_register_upstream_error", {
          connectionId,
          error: err && err.name ? err.name : "unknown",
        });
      }

      await push({ type: "registered", userEmail: verifiedEmail });
      log("info", "default_register", {
        connectionId,
        sub: verifiedEmail,
        freshdeskDomain: verifiedDomain,
      });
      return { statusCode: 200, body: "registered" };
    }

    // Unknown action.
    log("warn", "default_unknown_action", { connectionId, action: msg.action });
    return { statusCode: 400, body: "unknown action" };
  } catch (err) {
    log("error", "default_unhandled", {
      connectionId,
      error: err && err.name ? err.name : "unknown",
    });
    return { statusCode: 500, body: "error" };
  }
};
