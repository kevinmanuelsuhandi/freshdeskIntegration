// ============================================================================
//  ws-send  (Lambda Function URL, auth: NONE)
// ----------------------------------------------------------------------------
//  Called by Hoiio to push data to a connected agent's WebSocket.
//  Returns 410 (Gone) when the connection is dead so Hoiio can clean up
//  its stale sessionId mapping (lazy garbage collection).
//
//  Env vars: none. The API Gateway endpoint is hardcoded because this
//  Lambda lives outside the WebSocket API event loop and has no
//  event.requestContext.domainName to read from.
// ============================================================================

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

const ENDPOINT = "https://snsv14mr7l.execute-api.ap-southeast-1.amazonaws.com/production";

export const handler = async (event) => {
  const body = JSON.parse(event.body || "{}");
  const { sessionId, emailAgent, data } = body;

  if (!sessionId) {
    return { statusCode: 400, body: JSON.stringify({ error: "sessionId required" }) };
  }

  const client = new ApiGatewayManagementApiClient({ endpoint: ENDPOINT });

  try {
    await client.send(new PostToConnectionCommand({
      ConnectionId: sessionId,
      Data: Buffer.from(JSON.stringify(data)),
    }));
    return { statusCode: 200, body: JSON.stringify({ status: "sent", sessionId, emailAgent }) };
  } catch (err) {
    if (err.name === "GoneException") {
      // Stale connection — tell Hoiio to drop this sessionId.
      return {
        statusCode: 410,
        body: JSON.stringify({ status: "session_gone", sessionId, emailAgent }),
      };
    }
    console.error("ws-send error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "internal" }) };
  }
};
