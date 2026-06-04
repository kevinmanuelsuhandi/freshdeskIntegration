// ============================================================================
//  ws-send  (Lambda Function URL, auth: NONE — secured by per-tenant secret)
// ----------------------------------------------------------------------------
//  Called by Hoiio (server-to-server) to push messages down a WebSocket
//  connection. Function URL auth is NONE at AWS layer; in-handler auth uses
//  a per-tenant shared secret looked up from TENANT_CONFIGS — matching the
//  per-tenant model already used by click-to-call.
//
//  Request shape from Hoiio:
//    Header: X-Hoiio-Secret: <tenant's wsSendSecret>
//    Body:   { sessionId, freshdeskDomain, data: { type, ... } }
//
//  Security notes:
//    - Closes VAPT Finding 1 (unauthenticated ws-send) — per-tenant secret.
//    - Closes VAPT Finding 3 (enumeration oracle) — uniform 202 response.
//    - Addresses Finding 4 (input validation) — schema-shape checks.
//    - Addresses Finding 5 (structured logging) — JSON logs.
//    - Per-tenant: a leaked secret only impacts ONE tenant's ws-send path.
//
//  Env var (only one):
//    TENANT_CONFIGS    JSON, e.g.
//      { "b3works-support.freshdesk.com": { "wsSendSecret": "..." }, ... }
// ============================================================================
import crypto from "node:crypto";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

// Hardcoded: this is the API Gateway Management API endpoint for OUR WebSocket
// (same for every tenant). It's the URL Lambda uses to push messages into a
// connection; the browser uses the wss:// form, Lambda uses the https:// form.
const WS_MANAGEMENT_ENDPOINT =
  "https://snsv14mr7l.execute-api.ap-southeast-1.amazonaws.com/production";

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

// Constant-time secret comparison to avoid timing side-channel.
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function validateInput(body) {
  if (!body || typeof body !== "object") return "invalid body";
  if (
    typeof body.sessionId !== "string" ||
    body.sessionId.length === 0 ||
    body.sessionId.length > 128
  ) {
    return "sessionId must be a non-empty string under 128 chars";
  }
  if (
    typeof body.freshdeskDomain !== "string" ||
    body.freshdeskDomain.length === 0 ||
    body.freshdeskDomain.length > 255
  ) {
    return "freshdeskDomain required";
  }
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return "data must be an object";
  }
  if (
    typeof body.data.type !== "string" ||
    body.data.type.length === 0 ||
    body.data.type.length > 64
  ) {
    return "data.type must be a non-empty string under 64 chars";
  }
  if (JSON.stringify(body.data).length > 16 * 1024) return "data too large";
  return null;
}

export const handler = async (event) => {
  const sourceIp =
    (event.requestContext &&
      event.requestContext.http &&
      event.requestContext.http.sourceIp) ||
    "unknown";

  // --- Parse + validate body FIRST (we need freshdeskDomain for auth) ---
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    log("warn", "ws_send_bad_json", { sourceIp });
    return reply(400, { status: "invalid_json" });
  }
  const validationError = validateInput(body);
  if (validationError) {
    log("warn", "ws_send_validation_failed", {
      sourceIp,
      reason: validationError,
    });
    return reply(400, { status: "invalid_input" });
  }

  // --- Load tenant configs ---
  let tenantConfigs;
  try {
    tenantConfigs = JSON.parse(process.env.TENANT_CONFIGS || "{}");
  } catch {
    log("error", "ws_send_misconfigured", {
      sourceIp,
      reason: "tenant_configs_invalid",
    });
    return reply(500, { status: "misconfigured" });
  }

  // --- Look up tenant + verify per-tenant secret ---
  const tenant = tenantConfigs[body.freshdeskDomain];
  if (!tenant || !tenant.wsSendSecret) {
    // Unknown tenant looks the same as bad secret to the caller — uniform 401.
    log("warn", "ws_send_auth_denied", {
      sourceIp,
      reason: "unknown_tenant",
      freshdeskDomain: body.freshdeskDomain,
    });
    return reply(401, { status: "unauthorized" });
  }

  const headers = event.headers || {};
  const provided =
    headers["x-hoiio-secret"] || headers["X-Hoiio-Secret"] || "";
  if (!secretMatches(provided, tenant.wsSendSecret)) {
    log("warn", "ws_send_auth_denied", {
      sourceIp,
      reason: "bad_secret",
      freshdeskDomain: body.freshdeskDomain,
    });
    return reply(401, { status: "unauthorized" });
  }

  // --- Push to the WebSocket ---
  const client = new ApiGatewayManagementApiClient({
    endpoint: WS_MANAGEMENT_ENDPOINT,
  });
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: body.sessionId,
        Data: Buffer.from(JSON.stringify(body.data)),
      })
    );
    log("info", "ws_send_delivered", {
      sourceIp,
      freshdeskDomain: body.freshdeskDomain,
      sessionId: body.sessionId,
      type: body.data.type,
    });
    return reply(202, { status: "accepted" });
  } catch (err) {
    // Log real outcome for ops; uniform 202 to caller (Finding 3).
    if (err && err.name === "GoneException") {
      log("info", "ws_send_session_gone", {
        sourceIp,
        freshdeskDomain: body.freshdeskDomain,
        sessionId: body.sessionId,
      });
    } else {
      log("error", "ws_send_failed", {
        sourceIp,
        freshdeskDomain: body.freshdeskDomain,
        sessionId: body.sessionId,
        error: err && err.name ? err.name : "unknown",
      });
    }
    return reply(202, { status: "accepted" });
  }
};
