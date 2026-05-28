// ============================================================================
//  Custom App for B3Networks & Freshdesk Integration
// ----------------------------------------------------------------------------
//  Config model:
//    - WS_URL is the same for all tenants -> hardcoded below.
//    - Click-to-call host/path differ per tenant -> non-secure iparams.
//    - Click-to-call secret -> SECURE iparam, injected into the request header
//      by the platform (config/requests.json). Never present in this file.
//
//  Security notes:
//    - No request/response payloads are logged (avoids leaking agent PII).
//    - BACKEND items still open: verify agent identity server-side (don't trust
//      userEmail/userId from the body); use a short-lived token for the
//      WebSocket $connect authorizer; emit structured logs to CloudWatch.
// ============================================================================

// Same WebSocket endpoint for every tenant.
const WS_URL = "wss://snsv14mr7l.execute-api.ap-southeast-1.amazonaws.com/production";

const LOCK_NAME = "b3networks-freshdesk-ws-leader";
const CHANNEL_NAME = "b3networks-freshdesk-channel";

const state = {
  client: null,
  ws: null,
  agentEmail: null,
  agentId: null,
  agentName: null,
  freshdeskDomain: null,
  sessionId: null,
  isLeader: false,
  channel: null,
};

const $sessionId = document.getElementById("sessionId");
const $status = document.getElementById("status");

function setStatus(text, kind) {
  $status.textContent = text;
  $status.className = "status" + (kind ? " " + kind : "");
}

function setSessionId(id) {
  state.sessionId = id;
  $sessionId.textContent = id || "—";
}

async function init() {
  try {
    state.client = await app.initialized();
    state.client.events.on("app.activated", onAppActivated);
    state.client.events.on("cti.triggerDialer", onTriggerDialer);
    setupBroadcastChannel();
    setStatus("Freshdesk SDK ready. Waiting for app activation…");
  } catch (err) {
    console.error("app.initialized failed:", err);
    setStatus("Failed to initialize Freshdesk SDK.", "error");
  }
}

function setupBroadcastChannel() {
  if (typeof BroadcastChannel === "undefined") {
    console.warn("BroadcastChannel not supported.");
    return;
  }
  state.channel = new BroadcastChannel(CHANNEL_NAME);
  state.channel.onmessage = onChannelMessage;
}

function onChannelMessage(event) {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === "session_update") {
    setSessionId(msg.sessionId);
    setStatus("Connected via leader tab.", "connected");
  } else if (msg.type === "open_ticket") {
    openTicket(msg.ticketId);
  }
}

function broadcast(msg) {
  if (state.channel) state.channel.postMessage(msg);
}

function extractAgentInfo(data) {
  const lu = data && data.loggedInUser ? data.loggedInUser : {};
  const contact = lu.contact || {};
  return {
    email: contact.email || null,
    id: lu.id || null,
    name: contact.name || null,
  };
}

// Validate activation prerequisites; returns an error string, or null if OK.
function validateActivationData(agent, freshdeskDomain, iparams) {
  if (!agent.email) return "Could not read agent email.";
  if (!freshdeskDomain) return "Could not read Freshdesk domain.";
  if (!iparams || !iparams.call_action_host || !iparams.call_action_path) {
    return "Click-to-call endpoint is not configured (iparams).";
  }
  return null;
}

async function onAppActivated() {
  try {
    // iparams here are the NON-secure ones (call host/path). The secure secret
    // is NOT returned by iparams.get(); it is injected by the platform at
    // request time via config/requests.json.
    const [userData, domainData, iparams] = await Promise.all([
      state.client.data.get("loggedInUser"),
      state.client.data.get("domainName"),
      state.client.iparams.get(),
    ]);

    const agent = extractAgentInfo(userData);
    state.freshdeskDomain =
      domainData && domainData.domainName ? domainData.domainName : null;

    const error = validateActivationData(agent, state.freshdeskDomain, iparams);
    if (error) {
      setStatus(error, "error");
      return;
    }

    state.agentEmail = agent.email;
    state.agentId = agent.id;
    state.agentName = agent.name;

    setStatus("Agent: " + agent.email + " on " + state.freshdeskDomain);
    requestLeadership();
  } catch (err) {
    console.error("app.activated handler failed:", err);
    setStatus("Failed to fetch agent or domain info.", "error");
  }
}

async function holdLockForever() {
  await new Promise(function keepLockHeld(resolve) {
    state._lockReleaser = resolve;
  });
}

function requestLeadership() {
  if (!navigator.locks) {
    console.warn("Web Locks API not supported. Running standalone.");
    becomeLeader();
    return;
  }

  navigator.locks.request(LOCK_NAME, async function onLockAcquired() {
    becomeLeader();
    await holdLockForever();
  });

  setStatus("Running as follower tab.", "connected");
}

function becomeLeader() {
  state.isLeader = true;
  setStatus("Leader tab. Connecting WebSocket…");
  connectWebSocket();
}

// Fetch a short-lived (60s) WebSocket token via the secure Request method.
// The per-tenant secret is injected into the header by the platform; it never
// touches this code. Returns the token string, or null on failure.
async function fetchWsToken() {
  try {
    const res = await state.client.request.invokeTemplate("getWsToken", {
      body: JSON.stringify({
        freshdeskDomain: state.freshdeskDomain,
        userEmail: state.agentEmail,
      }),
    });
    const data = JSON.parse(res.response);
    return data && data.token ? data.token : null;
  } catch (err) {
    const status = err && err.status ? err.status : "unknown";
    setStatus("Could not get WS token (" + status + ").", "error");
    return null;
  }
}

// Acquire a fresh token, then open the WebSocket with it. Called on first
// connect AND on every reconnect, because each token lives only 60 seconds.
async function connectWebSocket() {
  const token = await fetchWsToken();
  if (!token) {
    // Retry shortly; without a token we cannot connect.
    setTimeout(connectWebSocket, 3000);
    return;
  }

  const url = WS_URL + "?token=" + encodeURIComponent(token);
  state.ws = new WebSocket(url);

  state.ws.onopen = function () {
    setStatus("Connected. Requesting session ID…");
    sendMessage({ action: "whoami" });
  };

  state.ws.onmessage = function (ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      // Do NOT log ev.data — it may contain sensitive content.
      console.warn("Discarded a non-JSON WebSocket frame.");
      return;
    }
    handleServerMessage(msg);
  };

  state.ws.onerror = function () {
    console.error("WebSocket error.");
    setStatus("Connection error. Check console.", "error");
  };

  state.ws.onclose = function (ev) {
    setStatus("Disconnected (code " + ev.code + "). Reconnecting…", "error");
    // Reconnect with a fresh token (the old one is expired/single-use).
    // Only the leader holds the socket, so only the leader reconnects.
    if (state.isLeader) {
      setTimeout(connectWebSocket, 2000);
    }
  };
}

function handleServerMessage(msg) {
  if (msg.type === "whoami") {
    setSessionId(msg.sessionId);
    broadcast({ type: "session_update", sessionId: msg.sessionId });
    // BACKEND item: the backend must VERIFY this identity rather than trust it.
    sendMessage({
      action: "register",
      userEmail: state.agentEmail,
      userId: state.agentId,
      userName: state.agentName,
      freshdeskDomain: state.freshdeskDomain,
    });
  } else if (msg.type === "registered") {
    setStatus("Leader ready. Agent: " + msg.userEmail, "connected");
  } else if (msg.type === "open_ticket") {
    openTicket(msg.ticketId);
    broadcast({ type: "open_ticket", ticketId: msg.ticketId });
  } else if (msg.type === "error") {
    setStatus("Server: " + msg.message, "error");
  } else {
    // Log only the message TYPE, never the full message (no PII).
    console.log("Unhandled server message type:", msg && msg.type);
  }
}

function sendMessage(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  } else {
    // Log only the action name, not the payload contents.
    console.warn("WS not open, dropped action:", payload && payload.action);
  }
}

function openTicket(ticketId) {
  if (!ticketId || !state.client || !state.client.interface) return;
  state.client.interface
    .trigger("click", { id: "ticket", value: String(ticketId) })
    .then(function () {
      setStatus("Opened ticket #" + ticketId, "connected");
    })
    .catch(function (err) {
      setStatus(
        "Failed to open ticket #" + ticketId + ": " + err.message,
        "error"
      );
    });
}

function getCallablePhoneNumber(event) {
  const data = event.helper.getData();
  const phoneNumber = data && data.number ? String(data.number) : null;
  if (!phoneNumber) return null;
  if (!state.agentEmail || !state.agentId || !state.freshdeskDomain) return null;
  return phoneNumber;
}

// Forward the call request via the SECURE Request method. The X-API-Key header
// is injected by the platform from the secure iparam (config/requests.json);
// it never appears in this code or in the browser.
async function postCallRequest(phoneNumber) {
  const body = {
    userId: state.agentId,
    userEmail: state.agentEmail,
    phoneNumber: phoneNumber,
    freshdeskDomain: state.freshdeskDomain,
    state: "clickToCall",
  };

  try {
    await state.client.request.invokeTemplate("clickToCall", {
      body: JSON.stringify(body),
    });
    return true;
  } catch (err) {
    // invokeTemplate rejects on non-2xx. Log status only, not the payload.
    const status =
      err && err.status ? err.status : err && err.code ? err.code : "unknown";
    setStatus("Call failed (" + status + ").", "error");
    return false;
  }
}

async function onTriggerDialer(event) {
  const phoneNumber = getCallablePhoneNumber(event);
  if (!phoneNumber) {
    setStatus("Not ready to call.", "error");
    return;
  }

  setStatus("Calling " + phoneNumber + "…");

  try {
    const ok = await postCallRequest(phoneNumber);
    if (ok) {
      setStatus("Call initiated to " + phoneNumber, "connected");
    }
  } catch (err) {
    setStatus("Call error: " + err.message, "error");
  }
}

document.addEventListener("DOMContentLoaded", init);