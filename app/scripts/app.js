// ============================================================================
//  Custom App for B3Networks & Freshdesk Integration
// ----------------------------------------------------------------------------
//  Config model:
//    - WS_URL is the same for all tenants -> hardcoded below.
//    - Click-to-call host/path differ per tenant -> non-secure iparams.
//    - Tenant secret -> SECURE iparam, injected into the request header
//      by the platform (config/requests.json). Never present in this file.
// ============================================================================

// Same WebSocket endpoint for every tenant.
const WS_URL = "wss://snsv14mr7l.execute-api.ap-southeast-1.amazonaws.com/production";

const LOCK_NAME = "b3networks-freshdesk-ws-leader";
const CHANNEL_NAME = "b3networks-freshdesk-channel";

// --- Validation patterns -----------------------------------------------------
const PHONE_REGEX = /^\+?[0-9\s\-()]{3,20}$/;
const WS_TYPES = new Set(["whoami", "registered", "open_ticket", "error"]);
const CHANNEL_TYPES = new Set(["session_update", "open_ticket"]);

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0 && v.length < 1024;
}

function isValidTicketId(v) {
  if (typeof v === "number") return Number.isInteger(v) && v > 0;
  if (typeof v === "string") return /^[0-9]{1,19}$/.test(v);
  return false;
}

function isValidSessionId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_=-]{1,64}$/.test(v);
}

function isValidPhoneNumber(v) {
  return typeof v === "string" && PHONE_REGEX.test(v);
}

// --- Structured logger -------------------------------------------------------
const logger = {
  _emit(level, event, fields) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(fields || {}),
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  },
  info(event, fields) { this._emit("info", event, fields); },
  warn(event, fields) { this._emit("warn", event, fields); },
  error(event, fields) { this._emit("error", event, fields); },
};

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
    logger.error("app_initialized_failed", { error: err.message });
    setStatus("Failed to initialize Freshdesk SDK.", "error");
  }
}

function setupBroadcastChannel() {
  if (typeof BroadcastChannel === "undefined") {
    logger.warn("broadcast_channel_unsupported");
    return;
  }
  state.channel = new BroadcastChannel(CHANNEL_NAME);
  state.channel.onmessage = onChannelMessage;
}

function handleChannelSessionUpdate(msg) {
  if (!isValidSessionId(msg.sessionId)) {
    logger.warn("channel_invalid_session_id");
    return;
  }
  setSessionId(msg.sessionId);
  setStatus("Connected via leader tab.", "connected");
}

function handleChannelOpenTicket(msg) {
  if (!isValidTicketId(msg.ticketId)) {
    logger.warn("channel_invalid_ticket_id");
    return;
  }
  openTicket(msg.ticketId);
}

const CHANNEL_HANDLERS = {
  session_update: handleChannelSessionUpdate,
  open_ticket: handleChannelOpenTicket,
};

function onChannelMessage(event) {
  const msg = event.data;
  if (!msg || !CHANNEL_TYPES.has(msg.type)) {
    logger.warn("channel_invalid_type", { type: msg && msg.type });
    return;
  }
  CHANNEL_HANDLERS[msg.type](msg);
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

    logger.info("agent_activated", { domain: state.freshdeskDomain });
    setStatus("Agent: " + agent.email + " on " + state.freshdeskDomain);
    requestLeadership();
  } catch (err) {
    logger.error("app_activated_failed", { error: err.message });
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
    logger.warn("web_locks_unsupported");
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
  logger.info("became_leader");
  setStatus("Leader tab. Connecting WebSocket…");
  connectWebSocket();
}

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
    logger.error("ws_token_fetch_failed", { status });
    setStatus("Could not get WS token (" + status + ").", "error");
    return null;
  }
}

async function connectWebSocket() {
  const token = await fetchWsToken();
  if (!token) {
    setTimeout(connectWebSocket, 3000);
    return;
  }

  const url = WS_URL + "?token=" + encodeURIComponent(token);
  state.ws = new WebSocket(url);

  state.ws.onopen = function () {
    logger.info("ws_open");
    setStatus("Connected. Requesting session ID…");
    sendMessage({ action: "whoami" });
  };

  state.ws.onmessage = function (ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      logger.warn("ws_non_json_frame");
      return;
    }
    handleServerMessage(msg);
  };

  state.ws.onerror = function () {
    logger.error("ws_error");
    setStatus("Connection error. Check console.", "error");
  };

  state.ws.onclose = function (ev) {
    logger.warn("ws_closed", { code: ev.code });
    setStatus("Disconnected (code " + ev.code + "). Reconnecting…", "error");
    if (state.isLeader) {
      setTimeout(connectWebSocket, 2000);
    }
  };
}

function handleWsWhoami(msg) {
  if (!isValidSessionId(msg.sessionId)) {
    logger.warn("ws_invalid_session_id");
    return;
  }
  setSessionId(msg.sessionId);
  broadcast({ type: "session_update", sessionId: msg.sessionId });
  sendMessage({
    action: "register",
    userEmail: state.agentEmail,
    userId: state.agentId,
    userName: state.agentName,
    freshdeskDomain: state.freshdeskDomain,
  });
}

function handleWsRegistered(msg) {
  if (!isNonEmptyString(msg.userEmail)) {
    logger.warn("ws_invalid_register_email");
    return;
  }
  logger.info("agent_registered");
  setStatus("Leader ready. Agent: " + msg.userEmail, "connected");
}

function handleWsOpenTicket(msg) {
  if (!isValidTicketId(msg.ticketId)) {
    logger.warn("ws_invalid_ticket_id");
    return;
  }
  openTicket(msg.ticketId);
  broadcast({ type: "open_ticket", ticketId: msg.ticketId });
}

function handleWsError(msg) {
  const safeMessage = isNonEmptyString(msg.message) ? msg.message.slice(0, 200) : "Unknown error";
  logger.error("ws_server_error", { message: safeMessage });
  setStatus("Server: " + safeMessage, "error");
}

const WS_HANDLERS = {
  whoami: handleWsWhoami,
  registered: handleWsRegistered,
  open_ticket: handleWsOpenTicket,
  error: handleWsError,
};

function handleServerMessage(msg) {
  if (!msg || !WS_TYPES.has(msg.type)) {
    logger.warn("ws_unknown_type", { type: msg && msg.type });
    return;
  }
  WS_HANDLERS[msg.type](msg);
}

function sendMessage(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  } else {
    logger.warn("ws_send_dropped", { action: payload && payload.action });
  }
}

function openTicket(ticketId) {
  if (!isValidTicketId(ticketId) || !state.client || !state.client.interface) return;
  state.client.interface
    .trigger("click", { id: "ticket", value: String(ticketId) })
    .then(function () {
      logger.info("ticket_opened", { ticketId });
      setStatus("Opened ticket #" + ticketId, "connected");
    })
    .catch(function (err) {
      logger.error("ticket_open_failed", { ticketId, error: err.message });
      setStatus("Failed to open ticket #" + ticketId, "error");
    });
}

function isAgentReady() {
  return Boolean(state.agentEmail && state.agentId && state.freshdeskDomain);
}

function getCallablePhoneNumber(event) {
  const data = event.helper.getData();
  const phoneNumber = data && data.number ? String(data.number) : null;
  if (!phoneNumber) return null;
  if (!isValidPhoneNumber(phoneNumber)) {
    logger.warn("call_invalid_phone_format");
    return null;
  }
  if (!isAgentReady()) return null;
  return phoneNumber;
}

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
    logger.info("call_initiated");
    return true;
  } catch (err) {
    const status = err && err.status ? err.status : err && err.code ? err.code : "unknown";
    logger.error("call_failed", { status });
    setStatus("Call failed (" + status + ").", "error");
    return false;
  }
}

// Throttle untuk cegah accidental atau malicious rapid-fire calls.
// Window: max 1 call per 3 detik; max 10 call per menit.
const CALL_MIN_GAP_MS = 3000;
const CALL_RATE_WINDOW_MS = 60000;
const CALL_RATE_MAX = 10;
const callHistory = [];

function isCallAllowed() {
  const now = Date.now();
  // Min gap antar call
  if (callHistory.length > 0) {
    const lastCall = callHistory[callHistory.length - 1];
    if (now - lastCall < CALL_MIN_GAP_MS) {
      return { allowed: false, reason: "too_soon" };
    }
  }
  // Rolling window
  const recentCalls = callHistory.filter((t) => now - t < CALL_RATE_WINDOW_MS);
  if (recentCalls.length >= CALL_RATE_MAX) {
    return { allowed: false, reason: "rate_exceeded" };
  }
  return { allowed: true };
}

function recordCall() {
  const now = Date.now();
  callHistory.push(now);
  // Cleanup old entries to prevent unbounded growth
  while (callHistory.length > 0 && now - callHistory[0] > CALL_RATE_WINDOW_MS) {
    callHistory.shift();
  }
}

async function onTriggerDialer(event) {
  const phoneNumber = getCallablePhoneNumber(event);
  if (!phoneNumber) {
    setStatus("Not ready to call.", "error");
    return;
  }

  const check = isCallAllowed();
  if (!check.allowed) {
    logger.warn("call_throttled", { reason: check.reason });
    const msg = check.reason === "too_soon"
      ? "Please wait before calling again."
      : "Call rate limit reached. Try again later.";
    setStatus(msg, "error");
    return;
  }

  recordCall();
  setStatus("Calling " + phoneNumber + "…");

  try {
    const ok = await postCallRequest(phoneNumber);
    if (ok) {
      setStatus("Call initiated to " + phoneNumber, "connected");
    }
  } catch (err) {
    logger.error("call_error", { error: err.message });
    setStatus("Call error.", "error");
  }
}

document.addEventListener("DOMContentLoaded", init);