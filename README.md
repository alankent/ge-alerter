# GE Alerter

Desktop notifications from **Gemini Enterprise** agents and workflows.

A scheduled agent or workflow finishes, calls one MCP tool, and a notification with action buttons pops up on your desktop
through Chrome. Click it to jump straight to the Gemini Enterprise conversation. Everything runs on Firebase and Cloud Run and
costs nothing while nothing is happening.

```
┌────────────────────┐   MCP over HTTPS    ┌──────────────────────┐   Admin SDK    ┌──────────────────────┐
│ Gemini Enterprise  │ ──────────────────▶ │ ge-alerter server    │ ─────────────▶ │ Firebase             │
│ agent / workflow   │  send_notification  │ (Cloud Run, scale 0) │  write + push  │  Realtime Database   │
│ (scheduled run)    │ ◀────────────────── │  MCP + OAuth server  │                │  Cloud Messaging     │
└────────────────────┘   tool result       └──────────────────────┘                │  Auth (Google)       │
                                                                                   └──────────┬───────────┘
                                                                        live DB listener  +  Web Push
                                                                                              ▼
                                                                                   ┌──────────────────────┐
                                                                                   │ GE Alerter PWA       │
                                                                                   │ (Chrome, installed)  │
                                                                                   │ inbox + desktop      │
                                                                                   │ notifications        │
                                                                                   └──────────────────────┘
```

## What is in the repo

| Path | What it is |
| --- | --- |
| `server/` | Node/TypeScript service for Cloud Run. Exposes the MCP endpoint (`/mcp`, Streamable HTTP), a minimal OAuth 2.0 authorization server that Gemini Enterprise's custom MCP connector requires, and a REST fallback (`/api/notify`). Writes to Realtime Database and sends Web Push via Firebase Cloud Messaging. |
| `web/` | Next.js PWA, exported as static files for Firebase Hosting. Google sign-in, live inbox, push registration, the OAuth consent screen, and a service worker that renders notifications with action buttons. |
| `firebase.json`, `database.rules.json` | Hosting config and database security rules. |
| `scripts/deploy-server.sh` | One-shot Cloud Run deploy. |
| `docs/ARCHITECTURE.md` | Design, data flows, alternatives considered, and known gaps. |

## MCP tools exposed to Gemini Enterprise

| Tool | Purpose |
| --- | --- |
| `send_notification` | `title`, optional `body`, `url`, up to two `actions` (`{title, url}`), `priority`, `tags`, `data`. Stores the alert in the user's inbox and pushes it to every registered browser. |
| `list_notifications` | Recent inbox entries, optionally unread only. Lets an agent avoid repeating itself. |
| `mark_notification_read` | Marks an entry read. |

Each notification shows the agent's buttons (or a default **Mark done**), opens its `url` on click, and falls back to the
**Default link** you set in the app (point it at your Gemini Enterprise inbox) when the agent sends none.

## Setup

You need a Firebase project on the Blaze plan (Cloud Run requires billing to be enabled; actual usage stays inside the
free tiers), the Firebase CLI, and the gcloud CLI.

### 1. Firebase project

1. Create a project at <https://console.firebase.google.com> (or reuse one).
2. **Authentication** → Sign-in method → enable **Google**. Under Settings → Authorized domains, add the Hosting domain
   (`PROJECT_ID.web.app`).
3. **Realtime Database** → Create database (locked mode; the rules in this repo are deployed below).
4. **Project settings → Cloud Messaging → Web Push certificates** → Generate key pair. This is the VAPID key.
5. **Project settings → General → Your apps** → Add a Web app. Copy the config values.

### 2. Server on Cloud Run

```bash
gcloud auth login
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com

export PROJECT_ID=your-project
export WEB_URL=https://your-project.web.app
export OAUTH_CLIENT_ID=$(openssl rand -hex 16)
export OAUTH_CLIENT_SECRET=$(openssl rand -base64 32)
./scripts/deploy-server.sh
```

The script prints the values to paste into Gemini Enterprise. Keep the client ID and secret somewhere safe.

The Cloud Run service runs as the default compute service account, which already has access to Realtime Database, Cloud
Messaging and Auth in the same project. Zero minimum instances means zero cost while idle.

### 3. PWA on Firebase Hosting

```bash
cp web/.env.example web/.env.local      # fill in Firebase web config, VAPID key, and the Cloud Run URL
cp .firebaserc.example .firebaserc      # set your project id
npm install
npm run build --workspace web
firebase deploy --only hosting,database
```

Open `https://PROJECT_ID.web.app`, sign in with Google, click **Enable notifications**, and set the **Default link** to
your Gemini Enterprise app URL. Install the PWA from Chrome's address bar if you want it as its own window.

### 4. Connect Gemini Enterprise

In the Google Cloud console go to **Gemini Enterprise → Data stores → Create data store → Custom MCP server** (you need
the Discovery Engine Editor role) and enter:

| Field | Value |
| --- | --- |
| MCP server URL | `https://SERVER/mcp` |
| Authorization URL | `https://SERVER/oauth/authorize` |
| Token URL | `https://SERVER/oauth/token` |
| Client ID / Client secret | the values from step 2 |
| Scopes | `notifications` |
| PKCE | optional, supported (S256) |

Google's redirect URI (`https://vertexaisearch.cloud.google.com/oauth-redirect`) is fixed and already allow-listed by the
server. The exact field labels and the screen's location move as the preview evolves, so follow the current
[custom MCP server docs](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server).

The first time Gemini Enterprise uses the connector it sends you to the PWA's consent page. Sign in with the same Google
account you use for Gemini Enterprise and click **Allow**. The server issues a refreshable token bound to your user, so
notifications from your scheduled runs land in your inbox and nobody else's.

### 5. Use it from an agent or workflow

Add the MCP data store to your Gemini Enterprise app, then in **Agent Designer** or **Workflow Builder** give the agent
access to the tool and tell it when to call it. Example instruction for a scheduled agent:

> When you have finished the task, call `send_notification` with a one-line title, a short summary in `body`, the link
> to the result as `url` if there is one, and `tags: ["weekly-digest"]`. If something needs my decision, set
> `priority: "high"`.

Workflow Builder can also use the MCP server as a step. Where neither is available, any HTTP step or script can call the
REST endpoint with the same bearer token:

```bash
curl -X POST https://SERVER/api/notify \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Weekly digest ready","body":"3 competitor updates","url":"https://..."}'
```

Reminder from Google's docs: scheduled agents run on your credentials, which expire every 14 days unless you refresh
them from the Agent Gallery or the Schedule tab.

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
