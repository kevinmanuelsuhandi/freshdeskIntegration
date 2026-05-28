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
      // Sesi sudah mati — beri tahu Hoiio supaya berhenti pakai sessionId ini
      return {
        statusCode: 410,
        body: JSON.stringify({ status: "session_gone", sessionId, emailAgent }),
      };
    }
    console.error("ws-send error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "internal" }) };
  }
};