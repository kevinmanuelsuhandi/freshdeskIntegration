// ============================================================================
//  ws-disconnect  ($disconnect route)
// ----------------------------------------------------------------------------
//  Cleans up SessionRegistry when the WebSocket closes (tab close, idle
//  timeout, hard 2-hour limit, etc.). TTL is a safety net for the rare case
//  this handler doesn't fire.
//
//  VAPT closures:
//    - Finding 9: structured JSON logging with agent identity.
// ============================================================================
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = "SessionRegistry";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const sourceIp =
    (event.requestContext &&
      event.requestContext.identity &&
      event.requestContext.identity.sourceIp) ||
    "unknown";
  const authorizer =
    (event.requestContext && event.requestContext.authorizer) || {};

  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { sessionId: connectionId },
      })
    );
    log("info", "ws_disconnect", {
      connectionId,
      sourceIp,
      sub: authorizer.agentEmail || null,
      freshdeskDomain: authorizer.freshdeskDomain || null,
    });
  } catch (err) {
    log("error", "ws_disconnect_failed", {
      connectionId,
      sourceIp,
      error: err && err.name ? err.name : "unknown",
    });
  }

  return { statusCode: 200, body: "Disconnected" };
};
