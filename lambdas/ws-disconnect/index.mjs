export const handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    try {
      await fetch(process.env.HOIIO_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.HOIIO_TOKEN}`,
        },
        body: JSON.stringify({
          sessionId: connectionId,
          state: "logout",
          at: Date.now(),
        }),
      });
    } catch (err) {
      console.error("$disconnect error:", err);
    }
    return { statusCode: 200, body: "Disconnected" };
  };