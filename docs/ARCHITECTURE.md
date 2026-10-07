# Architecture

## Goal

Run Gemini Enterprise agents and workflows on a schedule and get a desktop notification, with buttons, when they finish.
Zero cost while idle. One click from the notification to the conversation that produced it.

## The connection problem

Gemini Enterprise can call out in two ways: **A2A** to a registered agent, or **MCP** to a custom MCP server. Neither
has a native "notify the user's desktop" action, so something external has to receive a call and turn it into a push.

Custom MCP servers are the lighter of the two: Gemini Enterprise discovers tools with `tools/list`, calls them with
`tools/call`, and the agent gets the result back in-context. The catch is authentication. The custom MCP connector
requires OAuth 2.0 authorization-code with a client you register manually (client ID, client secret, authorization URL,
token URL, optional scopes and PKCE). It does not do dynamic client registration or discovery, and its redirect URI is
fixed at `https://vertexaisearch.cloud.google.com/oauth-redirect`. Users authorize interactively the first time, and
Gemini Enterprise refreshes the token afterwards.

That turns out to be a feature. Because every call carries a token bound to the user who authorized it, the server knows
*whose* desktop to notify without any API keys or per-agent configuration, and scheduled runs (which execute under the
user's credentials) route correctly.

## Where to deploy

The server and PWA do not have to live in the Gemini Enterprise project. Gemini Enterprise reaches a custom MCP server
over public HTTPS and authenticates with the OAuth client you configure, so any project with a public Cloud Run service
works. Firebase Auth in the PWA's project is independent of the identity Gemini Enterprise uses; the OAuth consent step
links the two.

| Stage | Server and PWA | Gemini Enterprise | Notes |
| --- | --- | --- | --- |
| Personal dev | a personal or sandbox project | the team's test instance | Any data store you create points at the sandbox URL. Fine for one developer. |
| Team test | same, or a shared dev project | the team's test instance | Each tester signs in to the PWA and approves the connection once. |
| Production | a project owned by the team that runs the production Gemini Enterprise, often the same project or a sibling | production instance | Run `scripts/bootstrap.sh` there, register a new data store in production with that project's URLs and secret. |

Things that can force co-location or extra setup:

- **Agent Gateway egress policies.** If the Gemini Enterprise project governs outbound MCP traffic through Agent
  Registry and Agent Gateway, an admin must register or allow the server's URL, and the app, gateway and registry must be
  regionally aligned. The server itself still need not move.
- **Cloud Run IAM instead of public access.** If policy forbids `allUsers` invokers, grant `roles/run.invoker` on the
  service to the Gemini Enterprise service agent from the other project. Cross-project grants work within one
  organization.
- **Organization policies.** Domain-restricted sharing blocks the public Cloud Run service; disabled service account key
  creation blocks key-based deploys. Run the bootstrap as yourself in Cloud Shell in that case.
- **Who can use it.** `ALLOWED_EMAIL_DOMAINS` (default `imdigital.com` in the bootstrap) is enforced three times: the
  Google account chooser is limited to the domain, the server refuses to approve a Gemini Enterprise connection for any
  other account, and the generated database rules deny reads and writes to anyone else. Someone outside the domain can
  still complete Google sign-in, but is signed straight back out and can reach no data.

## Components

### Server (`server/`, Cloud Run)

Express application with three responsibilities:

1. **OAuth 2.0 authorization server** (`src/oauth.ts`). Authorization-code grant with PKCE, refresh tokens, client
   authentication via form body or HTTP Basic, and RFC 8414 / RFC 9728 metadata so spec-following MCP clients (Claude,
   the MCP Inspector) also work. It has no login UI of its own: `/oauth/authorize` parks the request and redirects to the
   PWA's `/connect` page. The PWA authenticates the user with Firebase Auth (Google sign-in) and posts the decision back
   with a Firebase ID token; the server verifies the ID token with the Admin SDK, mints a one-time code, and sends the
   browser to Google's redirect URI. Tokens are opaque random strings stored SHA-256 hashed in Realtime Database.

2. **MCP server** (`src/mcp.ts`). Stateless Streamable HTTP (a fresh `McpServer` and transport per request, so Cloud
   Run can scale freely). Bearer tokens are resolved by middleware (`src/bearer.ts`) into the MCP SDK's `AuthInfo`, with
   the user id in `extra.uid`, which tool handlers read. Tools: `send_notification`, `list_notifications`,
   `mark_notification_read`.

3. **Notification pipeline** (`src/notify.ts`). Validates input, fills in the user's default URL, writes the record to
   `/users/{uid}/notifications`, and sends a data-only FCM message to every token under `/users/{uid}/devices`. Dead
   tokens reported by FCM are pruned. Each push carries a signed acknowledgement URL so the service worker's **Mark
   done** button can update the inbox without being signed in.

All storage and messaging sit behind small interfaces (`src/store/types.ts`) with Firebase and in-memory
implementations; the tests run the complete flow against the in-memory ones.

### PWA (`web/`, Firebase Hosting)

Static Next.js export. No server-side rendering, no API routes: the browser talks to Firebase directly (Auth, Realtime
Database listeners for the live inbox, Cloud Messaging for push) and to the Cloud Run server only for the OAuth consent
step. Security rules restrict each user to their own subtree and keep `/oauth` server-only.

The service worker (`public/sw.js`) receives data-only pushes and builds the notification itself, which is what makes
action buttons possible (FCM's automatic display path does not support them). The Firebase config reaches the worker
through the registration URL's query string, so the worker needs no build step. Clicking a button opens its URL,
focusing an existing app window when the URL is ours; clicking **Mark done** posts to the ack URL.

While the app is focused, FCM delivers to the page instead of the worker; the page shows the same notification, so
behaviour does not depend on which tab is in front.

## Data model (Realtime Database)

```
/oauth/pending/{id}      parked authorization requests (10 min)
/oauth/codes/{sha256}    one-time codes (5 min)
/oauth/tokens/{sha256}   access tokens (1 h)
/oauth/refresh/{sha256}  refresh tokens (90 d)
/users/{uid}/profile     email, display name (written by the PWA)
/users/{uid}/settings    { defaultUrl }
/users/{uid}/devices/{deviceKey}         { token, label, userAgent, createdAt }
/users/{uid}/notifications/{pushId}      { title, body, url, actions, priority, tags, data, createdAt, read, readAt, source, clientId }
```

Expired OAuth entries are swept lazily on the next write to the same bucket.

## Sequence: first connection

```
Gemini Enterprise ──GET /oauth/authorize?client_id&redirect_uri&state&code_challenge──▶ server
server ──302──▶ PWA /connect?request=ID
PWA: Google sign-in (Firebase Auth) → user clicks Allow
PWA ──POST /oauth/decision {request, approve} + Firebase ID token──▶ server
server: verify ID token, mint code ──▶ PWA ──302──▶ vertexaisearch.cloud.google.com/oauth-redirect?code&state
Gemini Enterprise ──POST /oauth/token (code, client_secret, code_verifier)──▶ server ──▶ access + refresh token
```

## Sequence: a scheduled run finishes

```
agent ──tools/call send_notification (Bearer token)──▶ server
server: token → uid; write /users/uid/notifications/N; FCM multicast to /users/uid/devices
Chrome service worker: push → showNotification(title, body, actions)
user clicks "Open" → url (or default link) opens; ack URL marks N read
PWA inbox (if open) updates live from the database listener
```

## Alternatives considered

| Option | Why not (for now) |
| --- | --- |
| **A2A agent** instead of MCP | Heavier: needs an agent card, task lifecycle, and registration in Agent Registry. MCP tools are discovered automatically and are the documented path for "custom internal tools". A2A remains an option if Workflow Builder cannot attach MCP tools to a step. |
| **Cloud Pub/Sub** between server and browser | Browsers cannot subscribe to Pub/Sub directly; a Pub/Sub push subscription would still need an HTTPS target, and the user wants richer state anyway. Realtime Database gives the live listener and the inbox for free. |
| **Firestore** instead of Realtime Database | Either works. Realtime Database was chosen because the user already uses it and its listener model fits an inbox. Swapping is contained to `src/store/firebase.ts` and the PWA hooks. |
| **Chrome extension** instead of a PWA | An extension could poll or hold a long-lived connection, but push through FCM already wakes the service worker with the tab closed, and a PWA installs without the Web Store. |
| **Email / Google Chat** from the workflow | Works out of the box, but no desktop buttons, no inbox, and noisier. |
| **Google as the OAuth provider** (point Gemini Enterprise at `accounts.google.com`) | Would avoid the custom authorization server, but Gemini Enterprise appends its own OAuth parameters and the docs say to enter base URLs only, so there is no way to request `access_type=offline`. Without a refresh token, scheduled runs would fail an hour after consent. The small in-house authorization server guarantees refreshable tokens. |

## Known gaps and things to verify in your tenant

- **Conversation link.** Whether an agent can learn the URL of its own conversation or run is not documented. The tool
  accepts a `url`; when the agent cannot supply one, the notification opens the **Default link** you configure (your
  Gemini Enterprise inbox), which is one click from the run.
- **Workflow Builder MCP steps.** Google's docs say MCP servers can be used as workflow steps or as tools for Gemini
  Agent steps. If your tenant's preview lacks this, the REST endpoint `/api/notify` can be called from any HTTP step with
  the same bearer token.
- **Field names in the console.** The custom MCP connector is in preview and the data-store form changes. The values
  are stable (URLs, client ID/secret, scopes); the labels may not be.
- **14-day credential refresh.** Scheduled agents stop when your Gemini Enterprise credentials lapse; that is a
  Gemini Enterprise limitation, unrelated to this server's tokens.
- **Cloud Run IAM.** The server is deployed with unauthenticated invocation because it enforces OAuth itself. If you
  prefer IAM on top, grant `roles/run.invoker` to the Gemini Enterprise service agent; Gemini Enterprise then sends an
  `X-Serverless-Authorization` ID token alongside the user's bearer token.
