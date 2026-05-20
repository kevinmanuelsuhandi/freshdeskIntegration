// ============================================================================
//  Custom App for B3Networks & Freshdesk Integration
// ----------------------------------------------------------------------------
//  Runs inside the Freshdesk agent workspace. Responsibilities:
//    1. Identify the logged-in agent and the Freshdesk tenant (domain).
//    2. Elect a single "leader" tab so only ONE WebSocket exists per agent,
//       even when multiple Freshdesk tabs are open.
//    3. Connect the WebSocket, register the agent <-> session mapping with the
//       backend, and share session info with follower tabs.
//    4. Handle click-to-call by forwarding the request to the backend.
//    5. Open tickets when the server pushes an "open_ticket" event.
// ============================================================================

// Shared secret. Compile-time constant. NOT real security, but blocks scans/bots.
// Rotate by regenerating + redeploying frontend + Lambda env vars together.
// (Placeholder here — the real value is injected at build time, never committed.)
const API_SHARED_SECRET = "YOUR_SHARED_SECRET";

// WebSocket URL with the shared secret appended as a query-string token, which
// the API Gateway Lambda authorizer validates on $connect.
const WS_URL = "WSS_URL" + encodeURIComponent(API_SHARED_SECRET);

// HTTPS endpoint (Hoiio programmable flow) that initiates a click-to-call.
const CALL_ACTION_URL = "PROGRAMMABLE_FLOW_OPEN_API";

// Logical name for the Web Locks API lock used in leader election.
const LOCK_NAME = "b3networks-freshdesk-ws-leader";
// Logical name for the BroadcastChannel used for cross-tab messaging.
const CHANNEL_NAME = "b3networks-freshdesk-channel";

// Runtime application state, populated during init/activation.
const state = {
  client: null,          // Freshworks SDK client instance
  ws: null,              // active WebSocket (leader tab only)
  agentEmail: null,      // logged-in agent email
  agentId: null,         // logged-in agent id
  agentName: null,       // logged-in agent name
  freshdeskDomain: null, // tenant domain; drives per-tenant backend routing
  sessionId: null,       // API Gateway connectionId for this socket
  isLeader: false,       // true if this tab owns the WebSocket connection
  channel: null,         // BroadcastChannel instance for cross-tab messaging
};

// Cached DOM references for the small status UI.
const $sessionId = document.getElementById("sessionId");
const $status = document.getElementById("status");

// Update the visible status line. `kind` toggles a CSS modifier class.
function setStatus(text, kind) {
  $status.textContent = text;
  $status.className = "status" + (kind ? " " + kind : "");
}

// Store and display the current session id (em dash when empty).
function setSessionId(id) {
  state.sessionId = id;
  $sessionId.textContent = id || "—";
}

// ---------------------------------------------------------------------------
//  Initialization
// ---------------------------------------------------------------------------

// Entry point: initialize the Freshworks SDK and register event listeners.
async function init() {
  try {
    state.client = await app.initialized();
    // Fired when the app becomes active in the agent workspace.
    state.client.events.on("app.activated", onAppActivated);
    // Freshdesk telephony event: fired when the agent clicks a phone number.
    state.client.events.on("cti.triggerDialer", onTriggerDialer);
    setupBroadcastChannel();
    setStatus("Freshdesk SDK ready. Waiting for app activation…");
  } catch (err) {
    console.error("app.initialized failed:", err);
    setStatus("Failed to initialize Freshdesk SDK.", "error");
  }
}

// Set up the cross-tab channel so follower tabs receive session updates and
// "open ticket" instructions from the leader tab.
function setupBroadcastChannel() {
  if (typeof BroadcastChannel === "undefined") {
    console.warn("BroadcastChannel not supported.");
    return;
  }
  state.channel = new BroadcastChannel(CHANNEL_NAME);
  state.channel.onmessage = onChannelMessage;
}

// Handle messages broadcast from the leader tab to follower tabs.
function onChannelMessage(event) {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === "session_update") {
    // Leader shares its session id so followers display the same value.
    setSessionId(msg.sessionId);
    setStatus("Connected via leader tab.", "connected");
  } else if (msg.type === "open_ticket") {
    // Leader relays an open-ticket instruction.
    openTicket(msg.ticketId);
  }
}

// Send a message to all other tabs (no-op if BroadcastChannel is unavailable).
function broadcast(msg) {
  if (state.channel) state.channel.postMessage(msg);
}

// Normalize the loggedInUser payload into a flat agent object.
function extractAgentInfo(data) {
  const lu = data && data.loggedInUser ? data.loggedInUser : {};
  const contact = lu.contact || {};
  return {
    email: contact.email || null,
    id: lu.id || null,
    name: contact.name || null,
  };
}

// ---------------------------------------------------------------------------
//  App activation: read agent + tenant context, then start leader election
// ---------------------------------------------------------------------------

async function onAppActivated() {
  try {
    // Fetch agent info and tenant domain in parallel.
    const [userData, domainData] = await Promise.all([
      state.client.data.get("loggedInUser"),
      state.client.data.get("domainName"),
    ]);

    const agent = extractAgentInfo(userData);
    state.freshdeskDomain =
      domainData && domainData.domainName ? domainData.domainName : null;

    // Both the agent email and the tenant domain are required to proceed.
    if (!agent.email) {
      setStatus("Could not read agent email.", "error");
      return;
    }
    if (!state.freshdeskDomain) {
      setStatus("Could not read Freshdesk domain.", "error");
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

// ---------------------------------------------------------------------------
//  Leader election (one WebSocket per agent across multiple tabs)
// ---------------------------------------------------------------------------

// Hold the lock indefinitely. While this promise stays unresolved, the Web
// Locks API keeps this tab as the lock owner (the leader). The lock is released
// automatically when the tab closes, letting a follower take over.
async function holdLockForever() {
  await new Promise(function keepLockHeld(resolve) {
    state._lockReleaser = resolve;
  });
}

// Try to become the leader tab. If the Web Locks API is unavailable, fall back
// to running standalone (each tab connects on its own).
function requestLeadership() {
  if (!navigator.locks) {
    console.warn("Web Locks API not supported. Running standalone.");
    becomeLeader();
    return;
  }

  // The callback runs only for the tab that acquires the lock; other tabs queue
  // and remain followers until the leader releases it (i.e. its tab closes).
  navigator.locks.request(LOCK_NAME, async function onLockAcquired() {
    becomeLeader();
    await holdLockForever();
  });

  setStatus("Running as follower tab.", "connected");
}

// Promote this tab to leader and open the WebSocket connection.
function becomeLeader() {
  state.isLeader = true;
  setStatus("Leader tab. Connecting WebSocket…");
  connectWebSocket();
}

// ---------------------------------------------------------------------------
//  WebSocket connection (leader tab only)
// ---------------------------------------------------------------------------

function connectWebSocket() {
  state.ws = new WebSocket(WS_URL);

  state.ws.onopen = function () {
    setStatus("Connected. Requesting session ID…");
    // Ask the server for our connectionId (used as the session id).
    sendMessage({ action: "whoami" });
  };

  state.ws.onmessage = function (ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      // Ignore any non-JSON frames defensively.
      console.warn("Non-JSON message:", ev.data, e);
      return;
    }
    handleServerMessage(msg);
  };

  state.ws.onerror = function (err) {
    console.error("WebSocket error:", err);
    setStatus("Connection error. Check console.", "error");
  };

  state.ws.onclose = function (ev) {
    // Show the close code; 1006 typically means the authorizer rejected us.
    setStatus("Disconnected (code " + ev.code + ").", "error");
  };
}

// Route inbound server messages to the appropriate action.
function handleServerMessage(msg) {
  if (msg.type === "whoami") {
    // Server returned our session id; display it and share with followers.
    setSessionId(msg.sessionId);
    broadcast({ type: "session_update", sessionId: msg.sessionId });
    // Register the agent <-> session mapping with the backend.
    sendMessage({
      action: "register",
      userEmail: state.agentEmail,
      userId: state.agentId,
      userName: state.agentName,
      freshdeskDomain: state.freshdeskDomain,
    });
  } else if (msg.type === "registered") {
    // Backend confirmed the mapping is stored.
    setStatus("Leader ready. Agent: " + msg.userEmail, "connected");
  } else if (msg.type === "open_ticket") {
    // Server asked us to open a ticket; do it and relay to other tabs.
    openTicket(msg.ticketId);
    broadcast({ type: "open_ticket", ticketId: msg.ticketId });
  } else if (msg.type === "error") {
    setStatus("Server: " + msg.message, "error");
  } else {
    console.log("Server message:", msg);
  }
}

// Send a JSON message over the WebSocket if the socket is open.
function sendMessage(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  } else {
    console.warn("WS not open, dropping:", payload);
  }
}

// ---------------------------------------------------------------------------
//  Ticket navigation
// ---------------------------------------------------------------------------

// Navigate the agent to a specific ticket via the Freshdesk interface API.
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

// ---------------------------------------------------------------------------
//  Click-to-call
// ---------------------------------------------------------------------------

// Validate the telephony event and return a callable phone number, or null if
// the number is missing or the agent context is not ready.
function getCallablePhoneNumber(event) {
  const data = event.helper.getData();
  const phoneNumber = data && data.number ? String(data.number) : null;
  if (!phoneNumber) return null;
  if (!state.agentEmail || !state.agentId || !state.freshdeskDomain) return null;
  return phoneNumber;
}

// Forward the call request to the backend (Hoiio flow) over HTTPS.
// Returns true on success, false on a non-2xx response.
async function postCallRequest(phoneNumber) {
  const res = await fetch(CALL_ACTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_SHARED_SECRET,
    },
    body: JSON.stringify({
      userId: state.agentId,
      userEmail: state.agentEmail,
      phoneNumber: phoneNumber,
      freshdeskDomain: state.freshdeskDomain,
      state: "clickToCall",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    setStatus("Call failed (" + res.status + "): " + errText.slice(0, 80), "error");
    return false;
  }
  return true;
}

// Handler for the Freshdesk dialer event (agent clicked a phone number).
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

// Kick everything off once the DOM is ready.
document.addEventListener("DOMContentLoaded", init);