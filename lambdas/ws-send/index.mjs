// ============================================================================
//  ws-send  (Lambda Function URL)
// ----------------------------------------------------------------------------
//  Hoiio calls this to push a message to an agent's WebSocket. Lookup by
//  (freshdeskDomain + userEmail) via DynamoDB GSI. Per-tenant secret from
//  Parameter Store, sent in standard `Authorization: Bearer <token>` header.
// ============================================================================
import crypto from "node:crypto";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const TABLE_NAME = "SessionRegistry";
const GSI_NAME = "byEmailAndTenant";
const WS_MANAGEMENT_ENDPOINT =
  "https://snsv14mr7l.execute-api.ap-southeast-1.amazonaws.com/production";
const CACHE_TTL_MS = 5 * 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
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

// Extracts the token from "Authorization: Bearer <token>". Case-insensitive
// scheme, tolerates extra whitespace. Returns null if not a Bearer header.
function extractBearer(headers) {
  const raw = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function validateInput(body) {
  if (!body || typeof body !== "object") return "invalid body";
  if (typeof body.freshdeskDomain !== "string" || !HOST_RE.test(body.freshdeskDomain)) {
    return "freshdeskDomain required (valid hostname)";
  }
  if (typeof body.userEmail !== "string" || !EMAIL_RE.test(body.userEmail) || body.userEmail.length > 254) {
    return "userEmail required (valid email)";
  }
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return "data must be an object";
  if (typeof body.data.type !== "string" || body.data.type.length === 0 || body.data.type.length > 64) {
    return "data.type must be a non-empty string under 64 chars";
  }
  if (JSON.stringify(body.data).length > 16 * 1024) return "data too large";
  return null;
}

export const handler = async (event) => {
  const sourceIp =
    (event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp) || "unknown";

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    log("warn", "ws_send_bad_json", { sourceIp });
    return reply(400, { status: "invalid_json" });
  }
  const validationError = validateInput(body);
  if (validationError) {
    log("warn", "ws_send_validation_failed", { sourceIp, reason: validationError });
    return reply(400, { status: "invalid_input" });
  }

  const wsSendSecret = await getSecret(
    `/freshdesk/tenants/${body.freshdeskDomain}/wsSendSecret`
  );
  if (!wsSendSecret) {
    log("warn", "ws_send_auth_denied", {
      sourceIp,
      reason: "unknown_tenant",
      freshdeskDomain: body.freshdeskDomain,
    });
    return reply(401, { status: "unauthorized" });
  }

  const provided = extractBearer(event.headers || {});
  if (!secretMatches(provided, wsSendSecret)) {
    log("warn", "ws_send_auth_denied", {
      sourceIp,
      reason: provided ? "bad_secret" : "missing_bearer",
      freshdeskDomain: body.freshdeskDomain,
    });
    return reply(401, { status: "unauthorized" });
  }

  // GSI lookup — composite key blocks cross-tenant by design.
  const lookupKey = `${body.freshdeskDomain}#${body.userEmail}`;
  let sessionId = null;
  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI_NAME,
        KeyConditionExpression: "emailDomainKey = :k",
        ExpressionAttributeValues: { ":k": lookupKey },
        Limit: 1,
      })
    );
    if (res.Items && res.Items.length > 0) sessionId = res.Items[0].sessionId;
  } catch (err) {
    log("error", "ws_send_lookup_failed", {
      sourceIp,
      freshdeskDomain: body.freshdeskDomain,
      error: err && err.name ? err.name : "unknown",
    });
    return reply(202, { status: "accepted" });
  }

  if (!sessionId) {
    log("info", "ws_send_no_active_session", {
      sourceIp,
      freshdeskDomain: body.freshdeskDomain,
      userEmail: body.userEmail,
    });
    return reply(202, { status: "accepted" });
  }

  const mgmt = new ApiGatewayManagementApiClient({ endpoint: WS_MANAGEMENT_ENDPOINT });
  try {
    await mgmt.send(
      new PostToConnectionCommand({
        ConnectionId: sessionId,
        Data: Buffer.from(JSON.stringify(body.data)),
      })
    );
    log("info", "ws_send_delivered", {
      sourceIp,
      freshdeskDomain: body.freshdeskDomain,
      sessionId,
      type: body.data.type,
    });
  } catch (err) {
    if (err && err.name === "GoneException") {
      log("info", "ws_send_session_gone", { sourceIp, freshdeskDomain: body.freshdeskDomain, sessionId });
    } else {
      log("error", "ws_send_failed", {
        sourceIp,
        freshdeskDomain: body.freshdeskDomain,
        sessionId,
        error: err && err.name ? err.name : "unknown",
      });
    }
  }
  return reply(202, { status: "accepted" });
};
