// ============================================================================
//  ws-default  ($default route)
// ----------------------------------------------------------------------------
//  On 'register', writes the session to DynamoDB SessionRegistry. Hoiio is NO
//  LONGER notified here — session state lives in DynamoDB and Hoiio looks up
//  via ws-send when it needs to push.
//
//  Identity always comes from authorizer context (verified by ws-authorizer),
//  not from the request body.
// ============================================================================
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = "SessionRegistry";
const TTL_SECONDS = 30 * 60;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function log(level, event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRegister(body) {
  if (body.userEmail !== undefined) {
    if (typeof body.userEmail !== "string" || !EMAIL_RE.test(body.userEmail) || body.userEmail.length > 254) {
      return "userEmail (if provided) must be a valid email";
    }
  }
  return null;
}

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const domainName = event.requestContext.domainName;
  const stage = event.requestContext.stage;

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

  const mgmt = new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
  const push = (payload) =>
    mgmt.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(payload)),
    }));

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
          connectionId, action: "register", reason: validationError,
        });
        await push({ type: "error", message: "invalid input" });
        return { statusCode: 400, body: "invalid input" };
      }
      if (!verifiedEmail || !verifiedDomain) {
        log("error", "default_no_verified_identity", { connectionId });
        return { statusCode: 401, body: "no verified identity" };
      }

      // Write session to DynamoDB. That's it — Hoiio is not called here.
      const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          sessionId: connectionId,
          userEmail: verifiedEmail,
          freshdeskDomain: verifiedDomain,
          emailDomainKey: `${verifiedDomain}#${verifiedEmail}`,
          ttl,
        },
      }));

      await push({ type: "registered", userEmail: verifiedEmail });
      log("info", "default_register", {
        connectionId, sub: verifiedEmail, freshdeskDomain: verifiedDomain,
      });
      return { statusCode: 200, body: "registered" };
    }

    log("warn", "default_unknown_action", { connectionId, action: msg.action });
    return { statusCode: 400, body: "unknown action" };
  } catch (err) {
    log("error", "default_unhandled", {
      connectionId, error: err && err.name ? err.name : "unknown",
    });
    return { statusCode: 500, body: "error" };
  }
};