// ============================================================================
//  ws-disconnect  (API Gateway WebSocket $disconnect)
// ----------------------------------------------------------------------------
//  Stale sessionIds are cleaned up lazily on the Hoiio side when ws-send
//  returns 410 (GoneException). No outbound call is made here.
// ============================================================================

export const handler = async (event) => {
  const { connectionId } = event.requestContext;
  console.log("WebSocket $disconnect:", connectionId);
  return { statusCode: 200, body: "Disconnected" };
};