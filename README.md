# Agent Notifications

Notifications from **Gemini Enterprise** agents and workflows, on your desktop, phone and tablet.

A scheduled agent or workflow finishes, calls one MCP tool, and a notification with action buttons pops up on your desktop
through Chrome. Click it to jump straight to the Gemini Enterprise conversation. Everything runs on Firebase and Cloud Run and
costs nothing while nothing is happening.

```
┌────────────────────┐   MCP over HTTPS    ┌──────────────────────┐   Admin SDK    ┌──────────────────────┐
│ Gemini Enterprise  │ ──────────────────▶ │ notifications server │ ─────────────▶ │ Firebase             │
│ agent / workflow   │  send_notification  │ (Cloud Run, scale 0) │  write + push  │  Realtime Database   │
│ (scheduled run)    │ ◀────────────────── │  MCP + OAuth server  │                │  Cloud Messaging     │
└────────────────────┘   tool result       └──────────────────────┘                │  Auth (Google)       │
                                                                                   └──────────┬───────────┘
                                                                        live DB listener  +  Web Push
                                                                                              ▼
                                                                                   ┌──────────────────────┐
                                                                                   │ Agent Notifications  │
                                                                                   │ PWA (installed)      │
                                                                                   │ inbox + desktop      │
                                                                                   │ notifications        │
                                                                                   └──────────────────────┘
```

## What is in the repo

| Path | What it is |
| --- | --- |
| `server/` | Node/TypeScript service for Cloud Run. Exposes the MCP endpoint (`/mcp`, Streamable HTTP), a minimal OAuth 2.0 authorization server that Gemini Enterprise's custom MCP connector requires, and a REST fallback (`/api/notify`). Writes to Realtime Database and sends Web Push via Firebase Cloud Messaging. |
| `web/` | Next.js PWA, exported as static files for Firebase Hosting. Google sign-in, live inbox, push registration, the OAuth consent screen, and a service worker that renders notifications with action buttons. |
| `firebase.json`, `database.rules.template.json` | Hosting config and database security rules; `scripts/gen-rules.mjs` fills in the allowed email domains. |
| `scripts/bootstrap.sh` | Provisions and deploys everything into one project; re-run to redeploy. |
| `docs/ARCHITECTURE.md` | Design, data flows, alternatives considered, and known gaps. |

## MCP tools exposed to Gemini Enterprise

| Tool | Purpose |
| --- | --- |
| `send_notification` | `title`, optional `body`, `url`, up to two `actions` (`{title, url}`), `priority`, `tags`, `data`. Stores the alert in the user's inbox and pushes it to every registered browser. |
| `list_notifications` | Recent inbox entries, optionally unread only. Lets an agent avoid repeating itself. |
| `mark_notification_read` | Marks an entry read. |
| `get_setup_instructions` | Optional `platform` (`ios`, `windows`, `mac`, `android`, `other`). Returns the setup page and the per-device instructions page (`/install`) with steps the agent can relay, so an agent can tell a user how to start receiving notifications. Read-only, so Gemini Enterprise runs it without asking for confirmation. |

Each notification shows the agent's buttons (or a default **Mark done**), opens its `url` on click, and falls back to the
**Default link** you set in the app (point it at your Gemini Enterprise inbox) when the agent sends none.

## Install

**[docs/INSTALL.md](docs/INSTALL.md)** is the full installation guide: prerequisites, credentials, the bootstrap and its
settings, the one console step for sign-in, connecting Gemini Enterprise and Claude, rolling out to users, uninstalling
and troubleshooting. In short:

```bash
git clone https://github.com/alankent/ge-alerter && cd ge-alerter
GCP_PROJECT_ID=my-project ./scripts/bootstrap.sh        # install or redeploy (idempotent)
GCP_PROJECT_ID=my-project ./scripts/teardown.sh         # list what an uninstall would delete
```

The bootstrap needs only `gcloud`, `curl` and `node` (Firebase is driven through its REST APIs) and names every resource
from `SLUG` (default `agent-notifications`): Cloud Run service `agent-notifications-server`, app and database
`<project>-agent-notifications`, OAuth client ID `agent-notifications-<project number>`.

## Local development

```bash
npm install
# Server with no Firebase at all (tokens and notifications held in memory, pushes logged):
STORE=memory OAUTH_CLIENT_ID=dev OAUTH_CLIENT_SECRET=dev \
  OAUTH_REDIRECT_URIS=https://vertexaisearch.cloud.google.com/oauth-redirect,http://localhost:9999/cb \
  npm run dev:server
# PWA (needs a real Firebase project in web/.env.local for sign-in and push):
npm run dev:web
```

Tests, type checks, builds:

```bash
npm test          # server unit/integration tests (OAuth flow, MCP tool calls, REST, ack links)
npm run typecheck
npm run build
```

Try the MCP endpoint by hand with the MCP Inspector (`npx @modelcontextprotocol/inspector`) pointed at
`http://localhost:8080/mcp` with an `Authorization: Bearer ...` header obtained through the OAuth flow, or run the test
suite, which drives the whole thing end to end.

## Cost

| Component | Idle cost | Notes |
| --- | --- | --- |
| Cloud Run (server) | $0 | min instances 0; 2M requests/month free |
| Realtime Database | $0 | notifications are a few hundred bytes each |
| Cloud Messaging | $0 | always free |
| Firebase Hosting | $0 | static files, free tier |
| Authentication | $0 | Google sign-in is free |

No SQL instance, no always-on VM, no Pub/Sub subscription to pay for.

## CI

`docs/github-workflow-ci.yml` is a ready-made GitHub Actions workflow (typecheck, tests, builds, container build). Move
it to `.github/workflows/ci.yml` and commit; it could not be pushed from the session that created this repo because
that token lacks the `workflow` scope.
