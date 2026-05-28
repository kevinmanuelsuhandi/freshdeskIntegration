// ============================================================================
//  ws-connect  (API Gateway WebSocket $connect)
// ----------------------------------------------------------------------------
//  Login lifecycle is handled in the `register` action (ws-default), because
//  tenant context (freshdeskDomain) is only known after the first message.
//  This handler exists for logging/audit only.
// ============================================================================

export const handler = async (event) => {
  const { connectionId } = event.requestContext;
  const headers = event.headers || {};
  const userAgent = headers["User-Agent"] || headers["user-agent"] || "unknown";

  // Log only the connection metadata, not the token.
  console.log("WebSocket $connect:", { connectionId, userAgent });

  return { statusCode: 200, body: "Connected" };
};
