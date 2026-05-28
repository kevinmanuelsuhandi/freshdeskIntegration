// ws-default Lambda (Node.js 20.x) — multi-tenant version
// Actions: heartbeat, whoami, register
//
// `register` action must include freshdeskDomain to route to correct Hoiio tenant.

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { getTenantConfig } from "./tenants.mjs";

export const handler = async (event) => {
  const { connectionId, domainName, stage } = event.requestContext;

  const apiClient = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    await pushToConnection(apiClient, connectionId, {
      type: "error",
      message: "Invalid JSON.",
    });
    return { statusCode: 400 };
  }

  const action = body.action;

  try {
    switch (action) {
      case "heartbeat":
        await pushToConnection(apiClient, connectionId, {
          type: "ack",
          at: new Date().toISOString(),
        });
        break;

      case "whoami":
        await pushToConnection(apiClient, connectionId, {
          type: "whoami",
          sessionId: connectionId,
        });
        break;

      case "register":
        await handleRegister(apiClient, connectionId, body);
        break;

      default:
        await pushToConnection(apiClient, connectionId, {
          type: "error",
          message: `Unknown action: ${action}`,
        });
    }

    return { statusCode: 200 };
  } catch (err) {
    console.error("ws-default error:", err);
    return { statusCode: 500 };
  }
};

async function handleRegister(apiClient, connectionId, body) {
  if (!body.userEmail || !body.freshdeskDomain) {
    await pushToConnection(apiClient, connectionId, {
      type: "error",
      message: "register requires userEmail and freshdeskDomain",
    });
    return;
  }

  let tenant;
  try {
    tenant = getTenantConfig(body.freshdeskDomain);
  } catch (err) {
    console.warn("Tenant lookup failed:", err.message);
    await pushToConnection(apiClient, connectionId, {
      type: "error",
      message: "Unknown or unauthorized tenant",
    });
    return;
  }

  await forwardToHoiio(tenant, {
    sessionId: connectionId,
    userEmail: body.userEmail,
    userId: body.userId || null,
    userName: body.userName || null,
    freshdeskDomain: body.freshdeskDomain,
    state: "register",
    registeredAt: new Date().toISOString(),
  });

  await pushToConnection(apiClient, connectionId, {
    type: "registered",
    sessionId: connectionId,
    userEmail: body.userEmail,
  });
}

async function pushToConnection(apiClient, connectionId, payload) {
  try {
    await apiClient.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload)),
      })
    );
  } catch (err) {
    if (err.name === "GoneException") {
      console.warn("Connection gone:", connectionId);
    } else {
      throw err;
    }
  }
}

async function forwardToHoiio(tenant, payload) {
  const res = await fetch(tenant.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tenant.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Hoiio call failed:", res.status, text);
    throw new Error(`Hoiio responded ${res.status}`);
  }
  return res;
}
