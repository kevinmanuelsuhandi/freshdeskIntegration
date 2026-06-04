# B3Networks ↔ Freshdesk Integration

WebSocket-based integration between a Freshdesk Custom App and the B3Networks
(Hoiio) telephony platform via AWS Lambda. Supports multi-tenant, multi-tab, and
click-to-call directly from the Freshdesk UI.

> Internal custom app — not published to the Freshworks Marketplace.

## Features

- **Real-time bidirectional communication** between the agent browser and the
  B3Networks backend via API Gateway WebSocket.
- **Short-lived token auth** for the WebSocket connection (60s JWT), so no
  static secret is ever placed in the WebSocket URL.
- **Click-to-call** from the built-in Freshdesk UI (the `cti.triggerDialer`
  event), forwarded to the per-tenant Hoiio flow via the Freshworks Request
  method (the per-tenant secret is injected into the header by the platform).
- **Server-pushed events** (e.g. `open_ticket`) from Hoiio to Freshdesk via
  `ws-send`, secured with a per-tenant shared secret.
- **Multi-tab support** via leader election (Web Locks API) + BroadcastChannel.
- **Multi-tenant routing**: one backend serves three or more Freshdesk tenants.
- **Session tracking**: each agent has a sessionId shared with Hoiio for
  targeted server pushes.

## Token flow

The frontend requests a token from `ws-token-issuer` over the Freshworks Request
method, so the per-tenant secret is injected into the header and never reaches
the browser. The issuer validates the secret against `TENANT_CONFIGS` and the
`userEmail` against an email format check, then returns a 60-second JWT signed
with `JWT_SIGNING_KEY`. The frontend opens the WebSocket with `?token=<jwt>`;
`ws-authorizer` verifies the signature and expiry on `$connect`. Each reconnect
fetches a fresh token.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Freshdesk Custom App (FDK 10.1.2, platform 3.0), vanilla JS |
| Backend compute | AWS Lambda (Node.js 20.x) |
| Real-time | AWS API Gateway WebSocket API |
| HTTPS endpoints | AWS Lambda Function URLs |
| Auth | Short-lived HS256 JWT (issued + verified by Lambda) |
| Multi-tab coordination | Web Locks API + BroadcastChannel API |
| Region | ap-southeast-1 (Singapore) |

## Repository Structure

```
.
├── freshdesk-app/              # Custom App source (FDK project)
│   ├── manifest.json
│   ├── app/
│   │   ├── index.html
│   │   ├── scripts/app.js
│   │   └── styles/
│   └── config/
│       ├── iparams.json
│       └── requests.json
├── lambdas/                    # Lambda function source code
│   ├── ws-authorizer.mjs       # verifies the 60s JWT on $connect
│   ├── ws-token-issuer.mjs     # issues the 60s JWT
│   ├── ws-connect.mjs          # logs the connect event
│   ├── ws-disconnect.mjs       # notifies Hoiio of logout
│   ├── ws-default.mjs          # handles whoami, register, etc.
│   └── ws-send.mjs             # Hoiio → frontend push (per-tenant secret)
├── docs/
│   ├── DEPLOYMENT.md
│   └── ARCHITECTURE.md
├── .gitignore
└── README.md
```

Click-to-call goes directly from the Freshdesk custom app to the per-tenant
Hoiio flow using the Freshworks Request method. No intermediary Lambda is
required for the call path.

## Quick Start (Development)

### Prerequisites

- Node.js 24.x
- FDK 10.1.2 (`npm install -g @freshworks/cli`)
- AWS CLI configured for `ap-southeast-1`
- AWS permissions for Lambda, API Gateway, and CloudWatch

### Run the Custom App locally

```bash
cd freshdesk-app
fdk run
```

Open Freshdesk with `?dev=true`. Fill the installation params at
`http://localhost:10001/custom_configs` (call host/path, token issuer host/path,
and the shared secret).

### Build the app package

Internal app — the 80% coverage gate does not apply:

```bash
fdk validate
fdk pack --skip-coverage   # -> dist/<app-name>.zip
```

## Configuration

### Lambda Environment Variables

| Variable | Used by | Description |
|---|---|---|
| `TENANT_CONFIGS` | `ws-default`, `ws-send`, `ws-token-issuer` | JSON map: domain → tenant-specific config. Each Lambda reads only the fields it needs (see below). |
| `JWT_SIGNING_KEY` | `ws-token-issuer`, `ws-authorizer` | Random key (same value in both) used to sign/verify the 60s JWT. Internal only; never in iparams or the frontend. |

#### TENANT_CONFIGS fields per Lambda

Each Lambda has its own `TENANT_CONFIGS` env var with only the fields it needs:

| Lambda | Fields read |
|---|---|
| `ws-token-issuer` | `token` (per-tenant secret used to authenticate token requests) |
| `ws-default` | `endpoint`, `token` (Hoiio endpoint + bearer token for register, etc.) |
| `ws-send` | `wsSendSecret` (per-tenant secret Hoiio uses when calling ws-send) |

Generate the JWT signing key once:

```bash
openssl rand -hex 32
```

Set the identical value on both `ws-token-issuer` and `ws-authorizer`.

Generate per-tenant `wsSendSecret` values (one per tenant) the same way and add
them to the `TENANT_CONFIGS` of `ws-send`.

### Installation Parameters (iparams)

Filled per tenant at install time:

| iparam | Secure | Description |
|---|---|---|
| `call_action_host` | no | Click-to-call host (e.g. `portal.hoiio.net`) |
| `call_action_path` | no | Click-to-call flow path |
| `token_issuer_host` | no | `ws-token-issuer` Function URL host (no scheme, no trailing slash) |
| `token_issuer_path` | no | Usually `/` |
| `api_shared_secret` | **yes** | Per-tenant secret; injected into the `X-API-Key` header by the platform |

Note: `token_issuer_host`/`path` and `call_action_host`/`path` are NOT secret
(they are used in the request URL, where secure iparams are not permitted).
Only `api_shared_secret` is secure.

## Multi-Tenant Setup

A single deployment serves multiple Freshdesk tenants. Tenant resolution happens
in the backend via `freshdeskDomain`.

Supported tenants:
- `b3works-support.freshdesk.com` (testing)
- `greengsmph.freshdesk.com` (production)
- `xanhsm-id.freshdesk.com` (production)

To add a new tenant:
1. Add an entry to `TENANT_CONFIGS` on the relevant Lambdas.
2. Install the custom app `.zip` and fill its iparams.
3. No code changes required.

## Multi-Tab Strategy

Hybrid: leader election + broadcast actions.
- Only one WebSocket per agent (held by the leader tab).
- The first tab acquires the Web Locks lock and becomes the leader.
- Followers receive session info via the BroadcastChannel.
- `open_ticket` is broadcast so any tab can navigate.
- Click-to-call works in any tab (independent of the WebSocket).
- When the leader tab closes, a follower takes over.

## Security Model

### What's protected
- **WebSocket connect** uses a 60-second JWT, not a static secret. A leaked
  token is useless within a minute. Each reconnect fetches a fresh token.
- **Token issuance** is gated by a per-tenant secret, validated against
  `TENANT_CONFIGS`. The `userEmail` is format-validated (no `"unknown"`
  fallback). A leak is limited to one tenant's blast radius.
- **The JWT signing key** lives only in Lambda — never in iparams or the browser.
- **`ws-send`** is authenticated by a per-tenant shared secret in the
  `X-Hoiio-Secret` header. Responses use a uniform 202 across delivered/gone/
  error outcomes, so unauthenticated callers cannot enumerate live sessions.
- **Click-to-call secret** is injected into the header by the platform (secure
  iparam); it is never present in `app.js`.
- **Server-side identity** in `ws-default` is taken from the verified authorizer
  context, not from request bodies. Even if the client lies about its email in
  a message body, the server uses the value that was signed into the JWT.
- **Structured JSON logging** with `sourceIp` and event type on all auth-relevant
  paths (issuer, authorizer, ws-send, ws-default, ws-connect), including denies.
- **Input validation** at every Lambda entry point (schema-shape checks on body
  fields, length caps, format regex for email and hostname).
- **No PII in logs** — phone numbers and message contents are omitted.

### Known limitations
- The token issuer validates the `userEmail` format but does not cross-check it
  against Freshdesk's agent list. Within a single tenant, an attacker holding
  that tenant's secret could request a token for any well-formed email.
  Per-tenant secrets prevent cross-tenant impersonation. Full closure would
  require a Freshdesk API lookup at token issuance time.

## Troubleshooting

### "Invalid Origin" when fetching the token
The Freshworks Request method rejected the host. Check that `token_issuer_host`
is a bare hostname (no `https://`, no trailing slash) and `token_issuer_path`
is `/`. Confirm `requests.json` uses the iparam template variable.

### "Could not get WS token (400)"
The issuer rejected the body. Most often the agent's `userEmail` is missing or
empty in dev environments. Check CloudWatch `/aws/lambda/ws-token-issuer` for
the `issuer_validation_failed` log entry and its `reason` field.

### "Could not get WS token (403)"
The issuer rejected the tenant. The `freshdeskDomain` is not a key in
`TENANT_CONFIGS` on `ws-token-issuer`. Check CloudWatch for the
`issuer_unknown_tenant` log entry.

### "Could not get WS token (401)"
The `api_shared_secret` does not match the tenant's `token` in `TENANT_CONFIGS`.

### Request not visible in the browser Network tab
Expected. Request-method calls are proxied by Freshworks, so they do not appear
as direct calls to the Lambda URL. Verify via CloudWatch instead.

### WebSocket "Disconnected (code 1006)"
The authorizer denied the connection. Check that `JWT_SIGNING_KEY` is identical
on `ws-token-issuer` and `ws-authorizer`, and that the token has not expired.
CloudWatch `/aws/lambda/ws-authorizer` will show `authorizer_denied` with a
`reason` field (`missing_token`, `bad_signature`, `expired`, etc.).

### Hoiio's ws-send call returns 401
Hoiio's `X-Hoiio-Secret` header does not match the tenant's `wsSendSecret` in
the `TENANT_CONFIGS` of `ws-send`, or the `freshdeskDomain` in the body is not
known to that Lambda.

