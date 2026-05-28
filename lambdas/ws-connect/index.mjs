export const handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
  
    const headers = event.headers || {};
    const userAgent = headers["User-Agent"] || headers["user-agent"] || "unknown";
  
    try {
      const res = await fetch(process.env.HOIIO_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.HOIIO_TOKEN}`,
        },
        body: JSON.stringify({
          sessionId: connectionId,
          userAgent,
          connectedAt: Date.now(),
          state: "login",
        }),
      });
  
      if (!res.ok) {
        console.error("Hoiio connect failed:", res.status, await res.text());
        // Fail-open: tetap izinkan koneksi meski notifikasi gagal.
        // Ganti ke `return { statusCode: 502 }` kalau mau fail-closed.
      }
  
      return { statusCode: 200, body: "Connected" };
    } catch (err) {
      console.error("$connect error:", err);
      return { statusCode: 200, body: "Connected" }; // fail-open
    }
  };