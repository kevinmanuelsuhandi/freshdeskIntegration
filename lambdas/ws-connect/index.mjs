// ============================================================================
//  ws-connect  (API Gateway WebSocket $connect route handler)
// ----------------------------------------------------------------------------
//  Runs after ws-authorizer has approved the connection. Logs the connect
//  event with structured JSON (Finding 5).
//
//  Identity from authorizer context is the verified one (set by ws-authorizer).
//  User-Agent comes from the connection handshake headers.
// ============================================================================

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
    (event.requestContext && event.requestContext.identity &&
      event.requestContext.identity.sourceIp) ||
    "unknown";
  const headers = event.headers || {};
  const userAgent = headers["User-Agent"] || headers["user-agent"] || "unknown";

  // Identity verified by ws-authorizer and forwarded via authorizer context.
  const authorizer = (event.requestContext && event.requestContext.authorizer) || {};

  log("info", "ws_connect", {
    connectionId,
    sourceIp,
    userAgent,
    sub: authorizer.agentEmail || null,
    freshdeskDomain: authorizer.freshdeskDomain || null,
  });

  return { statusCode: 200, body: "Connected" };
};