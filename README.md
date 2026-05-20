# B3Networks ↔ Freshdesk Integration

WebSocket-based integration between a Freshdesk Custom App and the B3Networks
(Hoiio) telephony platform via AWS Lambda. Supports multi-tenant, multi-tab, and
click-to-call directly from the Freshdesk UI.

> Internal custom app — not published to the Freshworks Marketplace.

## Features

- **Real-time bidirectional communication** between the agent browser and the
  B3Networks backend via API Gateway WebSocket.
- **Click-to-call** from the built-in Freshdesk UI (the `cti.triggerDialer` event).
- **Server-pushed events** (e.g. `open_ticket`) from Hoiio to Freshdesk over the
  WebSocket connection.
- **Multi-tab support** using leader election (Web Locks API) plus a
  BroadcastChannel for cross-tab coordination.
- **Multi-tenant routing**: one backend serves three or more Freshdesk tenants.
- **Session tracking**: each agent has a `sessionId` that is shared with Hoiio to
  enable targeted server pushes.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       Freshdesk Agent Browser                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │           Custom App (cti_global_sidebar iframe)              │  │
│  │  - Web Locks API: leader election across tabs                 │  │
│  │  - BroadcastChannel: cross-tab event propagation              │  │
│  │  - Only the leader tab holds the WebSocket                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────┬──────────────────────────────────┬────────────────────┘
             │                                  │
             │ WebSocket (wss://)                │ HTTPS POST
             │ ?token=<shared-secret>            │ X-API-Key header
             ▼                                  ▼
   ┌──────────────────────────┐      ┌──────────────────────────┐
   │ API Gateway WebSocket    │      │ Lambda Function URL      │
   │ + Lambda Authorizer      │      │ ws-action-call           │
   │ Routes:                  │      └──────────┬───────────────┘
   │  - $connect              │                 │
   │  - $disconnect           │                 │
   │  - $default              │                 │
   └─┬──────┬──────┬──────────┘                 │
     │      │      │                            │
     ▼      ▼      ▼                            ▼
   ┌─────────────────────────────────────────────────┐
   │              AWS Lambda (Node.js 20.x)          │
   │  - ws-authorizer    (authorizes $connect)       │
   │  - ws-connect       (logging)                   │
   │  - ws-disconnect    (logging, self-healing)     │
   │  - ws-default       (whoami, register)          │
   │  - ws-send          (push to client)            │
   │  - ws-action-call   (forwards call to Hoiio)    │
   └────────────────────┬────────────────────────────┘
                        │
                        │ Bearer auth, per-tenant endpoint
                        ▼
              ┌─────────────────────┐
              │   Hoiio / B3Networks │
              │   (REST API)         │
              └─────────────────────┘
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Freshdesk Custom App (FDK 10.1.2, platform 3.0), vanilla JS |
| Backend compute | AWS Lambda (Node.js 20.x) |
| Real-time | AWS API Gateway WebSocket API |
| HTTPS endpoints | AWS Lambda Function URLs |
| Multi-tab coordination | Web Locks API + BroadcastChannel API |
| Region | `ap-southeast-1` (Singapore) |

## Repository Structure

```
.
├── freshdesk-app/              # Custom App source (FDK project)
│   ├── manifest.json
│   ├── app/
│   │   ├── index.html
│   │   ├── scripts/app.js
│   │   └── styles/
│   │       ├── images/b3-logo.svg
│   │       └── style.css
│   └── config/                 # iparams (if used)
├── lambdas/                    # Lambda function source code
│   ├── ws-authorizer.mjs
│   ├── ws-connect.mjs
│   ├── ws-disconnect.mjs
│   ├── ws-default.mjs
│   ├── ws-send.mjs
│   └── ws-action-call.mjs
├── docs/
│   ├── DEPLOYMENT.md           # Step-by-step deployment guide
│   └── ARCHITECTURE.md         # Architecture detail and design decisions
├── .gitignore
└── README.md
```

## Quick Start (Development)

### Prerequisites

- Node.js 24.x
- FDK 10.1.2 (`npm install -g @freshworks/cli`)
- AWS CLI configured for the `ap-southeast-1` region
- Access to an AWS account with permissions for Lambda, API Gateway, and CloudWatch

### Run the Custom App locally

```bash
cd freshdesk-app
fdk run
```

Open your Freshdesk instance with `?dev=true` appended to the URL. The app
appears in the left sidebar.

### Build the app package

Because this is an internal custom app (not a Marketplace submission), the 80%
test-coverage gate does not apply. Skip it when packing:

```bash
fdk validate
fdk pack --skip-coverage
```

The packaged app is produced at `dist/<app-name>.zip`.

> Note: `fdk validate` may emit a warning on the `fetch()` call in `app.js`
> ("Use client.request when making API requests"). This is a non-blocking
> warning and does not prevent validation or packing.

### Deploy to Production

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full guide.

## Configuration

### Lambda Environment Variables

Set these on the relevant Lambdas (see the table in
[DEPLOYMENT.md](docs/DEPLOYMENT.md)):

| Variable | Used by | Description |
|---|---|---|
| `TENANT_CONFIGS` | `ws-default`, `ws-action-call` | JSON map of domain → `{endpoint, callEndpoint, token}` |
| `API_SHARED_SECRET` | `ws-authorizer`, `ws-action-call` | Shared secret used to authenticate the frontend |

### Frontend Constants (app.js)

```javascript
const WS_URL = "wss://<api-id>.execute-api.<region>.amazonaws.com/<stage>";
const CALL_ACTION_URL = "https://<function-url-id>.lambda-url.<region>.on.aws/";
const API_SHARED_SECRET = "<generated-secret>";
```

## Multi-Tenant Setup

A single deployment serves multiple Freshdesk tenants. Tenant resolution happens
in the backend via the `freshdeskDomain` field.

Supported tenants:
- `b3works-support.freshdesk.com` (testing)
- `greengsmph.freshdesk.com` (production)
- `xanhsm-id.freshdesk.com` (production)

To add a new tenant:
1. Add an entry to `TENANT_CONFIGS` (the env var on both Lambdas).
2. Install the custom app `.zip` on the new Freshdesk tenant.
3. No code changes are required.

## Multi-Tab Strategy

**Hybrid: leader election + broadcast actions.**

- Only one WebSocket per agent (held by the leader tab), which conserves backend
  resources.
- The first tab acquires the lock via the Web Locks API, becomes the leader, and
  opens the WebSocket.
- Other tabs become followers and receive session info via the BroadcastChannel.
- The `open_ticket` event is broadcast by the leader so every tab navigates.
- Click-to-call works in any tab (independent of the WebSocket).
- When the leader tab closes, a follower automatically becomes the new leader
  (about a 1–2 second delay).

## Security Model

### What's protected
- **Hoiio tokens** stay in backend env vars and never reach the frontend.
- **WebSocket `$connect`** is validated via a Lambda authorizer plus a shared
  secret query parameter.
- **Function URLs** are validated via an `X-API-Key` header check.
- **Tenant whitelist** — an unknown `freshdeskDomain` is rejected.

### Known limitations
- `API_SHARED_SECRET` is visible in the browser DevTools (Network tab). It deters
  bots, not determined attackers.
- No per-agent authentication (agent identity comes from the SDK but is not
  cryptographically verified).
- No request signing or integrity check.

### Roadmap
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a discussion of upgrading to
per-agent JWT authentication (SMI-based).

## Troubleshooting

### Custom App: "Disconnected (code 1006)"
The WebSocket authorizer rejected the connection. Check:
- `API_SHARED_SECRET` in the Lambda env var matches the frontend.
- API Gateway route `$connect` has `ApiKeyRequired: false`.
- CloudWatch `/aws/lambda/ws-authorizer` for the rejection reason.

### Click-to-call: "Failed to fetch"
A network error reaching the Function URL. Check:
- `CALL_ACTION_URL` in the frontend is correct.
- Function URL CORS is enabled (allow origin `*` or the Freshdesk domain).
- Function URL auth type is `NONE`.

### "Unknown or unauthorized tenant"
The `freshdeskDomain` is not present in `TENANT_CONFIGS`. Check:
- The domain spelling is exact (lowercase, no trailing slash).
- The Lambda env var was updated and the Lambda restarted (or freshly invoked).

## License

Internal use only.

## Contact

Kevin Manuel S — B3Networks