// ============================================================================
//  ws-default  (API Gateway WebSocket $default)
// ----------------------------------------------------------------------------
//  Handles client-initiated actions: heartbeat, whoami, register.
//
//  SECURITY:
//    Agent identity (email, freshdeskDomain) is read from the authorizer
//    context (event.requestContext.authorizer), NOT from the body. The
//    authorizer verified the JWT at $connect and embedded the verified
//    identity into the context. Trusting body fields would let a connected
//    agent impersonate another agent.
// ============================================================================

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { getTenantConfig } from "./tenants.mjs";

export const handler = async (event) => {
  const { connectionId, domainName, stage, authorizer } = event.requestContext;

  // Identity from JWT (set by ws-authorizer). Single source of truth.
  const verifiedEmail = authorizer && authorizer.agentEmail ? authorizer.agentEmail : null;
  const verifiedDomain = authorizer && authorizer.freshdeskDomain ? authorizer.freshdeskDomain : null;

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
  // Log action and verified identity; never log body payload.
  console.log("ws-default action:", { action, agent: verifiedEmail, domain: verifiedDomain });

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
        await handleRegister(apiClient, connectionId, body, verifiedEmail, verifiedDomain);
        break;

      default:
        await pushToConnection(apiClient, connectionId, {
          type: "error",
          message: `Unknown action: ${action}`,
        });
    }

    return { statusCode: 200 };
  } catch (err) {
    console.error("ws-default error:", err.message);
    try {
      await pushToConnection(apiClient, connectionId, {
        type: "error",
        message: "Internal error",
      });
    } catch {
      // ignore push failures during error path
    }
    return { statusCode: 500 };
  }
};

async function handleRegister(apiClient, connectionId, body, verifiedEmail, verifiedDomain) {
  // The authorizer must have provided identity. If not, the JWT setup is broken.
  if (!verifiedEmail || !verifiedDomain) {
    await pushToConnection(apiClient, connectionId, {
      type: "error",
      message: "Unauthorized: missing verified identity",
    });
    return;
  }

  let tenant;
  try {
    tenant = getTenantConfig(verifiedDomain);
  } catch (err) {
    console.warn("Tenant lookup failed:", err.message);
    await pushToConnection(apiClient, connectionId, {
      type: "error",
      message: "Unknown or unauthorized tenant",
    });
    return;
  }

  // userId / userName come from body (not in JWT). These are non-security
  // identifiers — backend uses verifiedEmail as canonical identity.
  await forwardToHoiio(tenant, {
    sessionId: connectionId,
    userEmail: verifiedEmail,
    userId: body.userId || null,
    userName: body.userName || null,
    freshdeskDomain: verifiedDomain,
    state: "register",
    registeredAt: new Date().toISOString(),
  });

  await pushToConnection(apiClient, connectionId, {
    type: "registered",
    sessionId: connectionId,
    userEmail: verifiedEmail,
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
