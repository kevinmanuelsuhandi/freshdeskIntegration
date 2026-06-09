# B3Networks ↔ Freshdesk Integration

A multi-tenant Freshdesk Custom App that connects agents to the B3Networks
(Hoiio) telephony platform. Built on AWS Lambda, API Gateway WebSocket, and
DynamoDB, with all per-tenant configuration centralized in AWS Systems Manager
Parameter Store.

> Internal custom app — not published to the Freshworks Marketplace.

## Capabilities

- **Real-time WebSocket** between the Freshdesk agent UI and AWS, secured by a
  short-lived (60-second) JWT issued per connection.
- **Click-to-call** from the Freshdesk CTI sidebar, forwarded to the partner
  endpoint via the Freshworks Request method. The partner bearer token never
  reaches the browser.
- **Server-pushed events** from Hoiio (e.g. `open_ticket`) routed to the right
  agent by looking up an active session in DynamoDB. Cross-tenant injection is
  blocked by design.
- **Multi-tab safe** via the Web Locks API and BroadcastChannel — only one
  WebSocket per agent across tabs.
- **Multi-tenant** by configuration only. Adding a tenant is an API call, no
  code change, no redeploy.
- **Self-managing sessions** via DynamoDB TTL plus `$disconnect` cleanup.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       Freshdesk Agent Browser                             │
│   Custom App (cti_global_sidebar)                                         │
│   - Web Locks leader election + BroadcastChannel                          │
│   - Only leader holds the WebSocket                                       │
└──────┬─────────────────────────┬─────────────────────────┬───────────────┘
       │                         │                         │
       │ 1. POST getWsToken      │ 3. WebSocket connect    │ click-to-call
       │    (Freshworks proxy,   │    wss://...?token=JWT  │ (Freshworks
       │     Bearer = issuer key)│                         │  proxy →
       ▼                         ▼                         │  partner)
┌──────────────────┐   ┌──────────────────────────┐        ▼
│ ws-token-issuer  │   │ API Gateway WebSocket    │  ┌──────────────┐
│ (Function URL)   │   │ + ws-authorizer ($connect)│  │ Partner /   │
│ validates per-   │   │ verifies JWT             │  │ Hoiio        │
│ tenant API key   │   │                          │  └──────────────┘
│ issues 60s JWT   │   └─────────────┬────────────┘
└──────┬───────────┘                 │
       │ token returned              │ on agent 'register'
       │                             ▼
       │                  ┌──────────────────────┐
       │                  │ ws-default writes    │
       │                  │ session row to       │
       │                  │ DynamoDB             │
       │                  └──────────────────────┘
       │
       ▼
┌─────────────────────────────┐       ┌──────────────────────────────────┐
│ Parameter Store              │       │ Hoiio (server-to-server) calls   │
│ /freshdesk/tenants/<d>/...   │       │ ws-send with userEmail+domain    │
│ /freshdesk/internal/...      │       │ → GSI lookup → push to WebSocket │
└──────────────────────────────┘       └──────────────────────────────────┘
```

### Why every layer exists

- **Two URLs for the WebSocket**: agents connect via `wss://`, Lambda pushes
  back via the management API at `https://` on the same host. Different paths,
  same API Gateway.
- **JWT lifetime is 60 s**: long enough to cover the gap between fetching the
  token and opening the socket, short enough that a leaked token is useless
  by the time anyone copies it from DevTools.
- **DynamoDB is the source of truth for active sessions**: Hoiio doesn't know
  sessionIds — it knows only `(freshdeskDomain, userEmail)`. The GSI
  `byEmailAndTenant` is keyed on the composite `<domain>#<email>`, so a tenant
  A secret can only resolve sessions registered by tenant A.
- **TTL is the safety net**: each session row expires 30 minutes after the
  last write. The normal cleanup is the `$disconnect` route; TTL handles the
  cases where it doesn't fire.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Freshdesk Custom App (FDK 10.1.2, platform 3.0), vanilla JS |
| Backend compute | AWS Lambda (Node.js 20.x) |
| Real-time transport | AWS API Gateway WebSocket API |
| HTTPS endpoints | Lambda Function URLs (auth: NONE at AWS, in-handler bearer) |
| Session registry | AWS DynamoDB (on-demand, TTL-managed) |
| Secret + config storage | AWS Systems Manager Parameter Store (SecureString) |
| AWS SDK | Lambda Layer, pinned `@aws-sdk/* 3.990.0` |
| Auth on the wire | Short-lived HS256 JWT, `Authorization: Bearer` |
| Region | ap-southeast-1 (Singapore) |

## Repository structure

```
.
├── README.md
├── manifest.json              # FDK manifest
├── package.json               # vitest dev dependencies only
├── package-lock.json
├── vitest.config.js
├── app/                       # Freshdesk Custom App
│   ├── index.html
│   ├── scripts/app.js
│   └── styles/
├── config/                    # FDK installation params + request templates
│   ├── iparams.json
│   └── requests.json
├── lambdas/                   # AWS Lambda source (Node.js 20.x)
│   ├── ws-token-issuer/       #   issues 60 s JWT
│   ├── ws-authorizer/         #   verifies JWT on $connect
│   ├── ws-connect/            #   logs the connect event
│   ├── ws-default/            #   handles whoami + register
│   ├── ws-disconnect/         #   cleans up DynamoDB row
│   ├── ws-send/               #   Hoiio → frontend push
│   └── onboard-tenant/        #   admin API to manage tenant secrets
└── infrastructure/
    └── sdk-layer/             # Lambda Layer with pinned AWS SDK v3 packages
        └── nodejs/
            ├── package.json
            └── package-lock.json
```

Click-to-call does not have a dedicated Lambda. The Freshdesk Custom App calls
the partner endpoint directly via the Freshworks Request method.

## Configuration

### Lambda environment variables

After the migration to Parameter Store, the Lambdas need **no environment
variables**. Everything is read from `/freshdesk/...` parameters and cached
in memory for 5 minutes.

### Parameter Store layout

```
/freshdesk/internal/jwtSigningKey            (SecureString)  # signs & verifies the 60 s JWT
/freshdesk/internal/onboardingApiKey         (SecureString)  # admin bearer for onboard-tenant

/freshdesk/tenants/<domain>/wsSendSecret     (SecureString)  # Hoiio  → ws-send bearer
/freshdesk/tenants/<domain>/issuerApiKey     (SecureString)  # Frontend → ws-token-issuer bearer
```

Two internal secrets, two per-tenant secrets. `issuerApiKey` and `wsSendSecret`
are intentionally separate (Finding 6: no shared secret across trust
boundaries). `jwtSigningKey` lives only in Lambda — never in iparams, never
in the browser.

### Installation params (filled per tenant at install time)

| iparam | Secure | Purpose |
|---|---|---|
| `call_action_host` | no | Partner hostname for click-to-call (no scheme) |
| `call_action_path` | no | Partner click-to-call flow path |
| `tenant_token` | **yes** | Bearer for click-to-call calls to the partner |
| `api_shared_secret` | **yes** | Bearer for `ws-token-issuer` (= `issuerApiKey` in Parameter Store) |

The WebSocket URL and issuer host are hardcoded in `app/scripts/app.js` and
`config/requests.json` respectively — they are the same for every tenant.

### Lambda IAM permissions

Each Lambda needs read access to its own Parameter Store path plus the KMS
key that decrypts SecureString values:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:ap-southeast-1:*:parameter/freshdesk/*"
    },
    {
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": {
        "StringEquals": { "kms:ViaService": "ssm.ap-southeast-1.amazonaws.com" }
      }
    }
  ]
}
```

`onboard-tenant` additionally needs `ssm:PutParameter`, `ssm:DeleteParameters`,
and `ssm:GetParametersByPath`.

`ws-default`, `ws-send`, and `ws-disconnect` additionally need DynamoDB
permissions on `SessionRegistry` (PutItem / Query / DeleteItem) and the
`byEmailAndTenant` GSI.

## DynamoDB schema — `SessionRegistry`

| Attribute | Type | Purpose |
|---|---|---|
| `sessionId` | S (PK) | API Gateway WebSocket `connectionId` |
| `userEmail` | S | Email of the agent (from authorizer context, not from body) |
| `freshdeskDomain` | S | Tenant domain (from authorizer context) |
| `emailDomainKey` | S (GSI PK) | Composite `<freshdeskDomain>#<userEmail>` for the GSI |
| `ttl` | N | Epoch seconds, 30 minutes from the last write |

**GSI `byEmailAndTenant`** is keyed on `emailDomainKey`. The composite key
inherently blocks cross-tenant lookups: a tenant A request cannot resolve a
tenant B session, even if the secret were leaked.

TTL is enabled on the `ttl` attribute. Capacity mode: on-demand.

## Multi-tenant onboarding

Adding a new tenant is one API call to `onboard-tenant`. No code, no redeploy.

```bash
curl -X POST <onboard-tenant-function-url> \
  -H "Authorization: Bearer <onboardingApiKey>" \
  -H "Content-Type: application/json" \
  -d '{
        "action": "upsert",
        "freshdeskDomain": "newcustomer.freshdesk.com",
        "secrets": {
          "wsSendSecret":  "<openssl rand -hex 32>",
          "issuerApiKey":  "<openssl rand -hex 32>"
        }
      }'
```

After the call:

1. Pass `wsSendSecret` to Hoiio so they can set the bearer for ws-send.
2. Install the Custom App on the tenant's Freshdesk and fill the iparams,
   including `api_shared_secret = issuerApiKey`.

To list configured tenants: `{"action":"list"}`.
To remove one: `{"action":"remove","freshdeskDomain":"..."}`.

The `onboard-tenant` Lambda is rate-limited to 10 requests/minute per source
IP and emits a structured `onboard_auth_denied` log on every failed bearer
check — wire a CloudWatch alarm to that pattern.

## Multi-tab strategy

Hybrid leader election + broadcast actions.

- The first tab to acquire the Web Locks lock becomes the leader.
- Only the leader holds the WebSocket.
- Server pushes (e.g. `open_ticket`) go to the leader; the leader rebroadcasts
  over the BroadcastChannel so any tab can react.
- Click-to-call works in any tab — it's an independent HTTPS call to the
  partner endpoint, not a WebSocket message.
- When the leader tab closes, the lock releases and a follower takes over.

## Security model

### Closed in the current iteration

- **Cross-tenant injection** — `ws-send` looks up sessions through a GSI keyed
  on `<freshdeskDomain>#<userEmail>`. The composite key cannot be tricked
  across tenants even with a leaked secret.
- **Static secret on the wire** — the WebSocket connect URL carries a 60 s JWT,
  not a static key. The JWT signing key never leaves Lambda.
- **Shared secret across trust boundaries** — `tenant_token` (partner bearer)
  and `api_shared_secret` (issuer bearer) are separate values per tenant.
- **Session-bound identity** — `ws-default` and downstream code use
  `agentEmail` / `freshdeskDomain` from the verified authorizer context, never
  from the body.
- **Enumeration via differentiated error codes** — `ws-token-issuer` returns a
  uniform 401 for both unknown tenant and bad key. `ws-send` returns a uniform
  202 across delivered / gone / error.
- **Structured logging** on every auth-relevant path including the authorizer's
  deny path. Source IP and event type are always included.
- **Input validation** at every entry point — schema-shape checks, length caps,
  email and hostname format regex.
- **Log retention** — all Lambda log groups set to 365 days.
- **SDK pinning** — `@aws-sdk/* 3.990.0` shipped via a Lambda Layer; all
  Lambdas attach the layer and the runtime SDK is overridden.
- **No PII in logs** — phone numbers and message bodies are never logged.

### Known limitations (open items)

- **Agent identity isn't cross-checked against Freshdesk.** The token issuer
  validates the email format but doesn't call the Freshdesk API to confirm
  the email belongs to a real agent of that tenant. Within a single tenant,
  anyone with that tenant's `issuerApiKey` can request a token for any
  well-formed email. Per-tenant secrets contain the blast radius to a single
  tenant. Closing this fully requires a Freshdesk API key per tenant and an
  extra HTTP call per token issuance.
- **No rate limiting on public Function URLs.** A flood of requests with a
  bad bearer wastes Lambda invocations but cannot break authentication
  (256-bit secrets are not practically brute-forceable). Mitigation deferred;
  monitor invocation counts via CloudWatch.
- **`onboard-tenant` uses a static admin bearer.** Compensating controls: rate
  limit, structured auth-failure logging, and the admin key is held only in
  Parameter Store + a password manager (never in iparams, never in the repo).
- **Deployment is paste-into-Console.** The SDK Layer enforces pinned SDK
  versions, but Lambda function code itself is deployed by manual paste. No
  IaC is checked in for Lambda configuration. This is an accepted trade-off
  given the small footprint.

## Operations

### Generating new secrets

```bash
openssl rand -hex 32   # 256-bit, hex-encoded — use for every secret
```

Use one fresh value per role per tenant. Don't reuse.

### Rotating `jwtSigningKey`

`ws-token-issuer` and `ws-authorizer` both read this from Parameter Store and
cache it for 5 minutes. To rotate without downtime:

1. Update `/freshdesk/internal/jwtSigningKey` in Parameter Store.
2. Within 5 minutes, both Lambdas pick up the new value.

During the rotation window, tokens minted with the old key may be rejected by
the authorizer if it has refreshed first. In practice this is a few-second
gap during which agents may need to reconnect. Schedule rotations during a
quiet window.

### Rotating a tenant secret

```bash
curl -X POST <onboard-tenant-function-url> \
  -H "Authorization: Bearer <onboardingApiKey>" \
  -H "Content-Type: application/json" \
  -d '{
        "action": "upsert",
        "freshdeskDomain": "<domain>",
        "secrets": { "wsSendSecret": "<new>", "issuerApiKey": "<new-or-same>" }
      }'
```

`upsert` overwrites whichever fields you pass. After the call, distribute the
new values: `wsSendSecret` to Hoiio, `issuerApiKey` to the tenant's Freshdesk
admin (to update the `api_shared_secret` iparam).

### Investigating a session

In CloudWatch Logs Insights, across all the Lambda log groups, search for:

```
fields @timestamp, level, event, freshdeskDomain, sub, sourceIp
| filter sub = "agent@example.com"
| sort @timestamp desc
| limit 100
```

Every Lambda emits structured JSON, so this works across the whole flow.

### SDK Layer updates

Source lives in `infrastructure/sdk-layer/`. To update:

```bash
cd infrastructure/sdk-layer/nodejs
# edit package.json, bump versions
rm -rf node_modules package-lock.json
npm install --omit=dev
cd ..
zip -r freshdesk-sdk-layer.zip nodejs/
```

Upload as a new Layer version in the AWS Console, then update each Lambda to
point at the new version. Commit the new `package-lock.json` to the repo.

## Troubleshooting

### `Could not get WS token (400)` in the frontend
The issuer rejected the body. Most often `userEmail` is missing or malformed.
Check `/aws/lambda/ws-token-issuer` for `issuer_validation_failed` and read
the `reason` field.

### `Could not get WS token (401)`
The `Authorization: Bearer` value doesn't match the tenant's `issuerApiKey`
in Parameter Store, or the `freshdeskDomain` isn't a known tenant. Both cases
return 401 by design (no enumeration oracle). Check
`/aws/lambda/ws-token-issuer` → `issuer_auth_denied` for the actual reason.

### WebSocket `Disconnected (code 1006)`
The authorizer denied the connect. Confirm `JWT_SIGNING_KEY` in Parameter
Store matches what's cached in both `ws-token-issuer` and `ws-authorizer`,
and that the token hasn't expired. `/aws/lambda/ws-authorizer` →
`authorizer_denied` has the reason (`missing_token`, `bad_signature`,
`expired`, etc).

### Hoiio's `ws-send` call returns 401
Hoiio's `Authorization: Bearer` value doesn't match the tenant's `wsSendSecret`
in Parameter Store, or the `freshdeskDomain` in the body isn't known.

### Hoiio's `ws-send` returns 202 but the agent doesn't see anything
There's no active session for that `(freshdeskDomain, userEmail)` in
DynamoDB. The agent may be logged out, or the session may have expired
(30 minute TTL). Check the SessionRegistry table directly, or look in
`/aws/lambda/ws-send` for `ws_send_no_active_session`.

### Request not visible in the browser's Network tab
Expected. Freshworks Request method calls are proxied server-side by
Freshworks, so they don't appear as direct calls to the Lambda URL. Confirm
the call reached AWS via CloudWatch.

## License

Internal use only.

## Contact

Kevin Manuel S — B3Networks