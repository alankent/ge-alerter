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
| `firebase.json`, `database.rules.template.json` | Hosting config and database security rules; `scripts/gen-rules.mjs` fills in the allowed email domains. |
| `scripts/bootstrap.sh` | Provisions and deploys everything into one project; re-run to redeploy. |
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

Deployment is one idempotent script, `scripts/bootstrap.sh`. It enables the APIs, adds Firebase, creates the Realtime
Database, web app and Hosting site, generates the OAuth client secret in Secret Manager, creates a least-privilege
runtime service account, deploys the server to Cloud Run, builds and deploys the PWA and database rules, and prints the
values for Gemini Enterprise. Re-run it to redeploy.

### 1. Project (console clicks, once)

1. In the [Firebase console](https://console.firebase.google.com) create a project, or add Firebase to an existing
   Google Cloud project. A shared test project is fine: the app gets its own database instance and hosting site (both
   named `<project>-ge-alerter`, override with `APP_NAME`) and never touches the project's defaults. The project does
   not need to be the one where Gemini Enterprise is installed; see "Where to deploy" in `docs/ARCHITECTURE.md`.
2. Switch it to the **Blaze** plan. Cloud Run needs billing enabled; actual usage stays inside the free tiers.
3. **Authentication → Get started → Sign-in method → Google → Enable.** This is the one step with no API.

### 2. Run the bootstrap

Either run it yourself, for example in [Cloud Shell](https://shell.cloud.google.com) where gcloud is already signed in:

```bash
git clone https://github.com/alankent/ge-alerter && cd ge-alerter
GCP_PROJECT_ID=your-project ./scripts/bootstrap.sh
```

Or let a Claude Code cloud session run it with a service account key. Create the key in Cloud Shell:

```bash
PROJECT=your-project
gcloud iam service-accounts create ge-alerter-deployer --project $PROJECT
gcloud projects add-iam-policy-binding $PROJECT \
  --member serviceAccount:ge-alerter-deployer@$PROJECT.iam.gserviceaccount.com --role roles/owner
gcloud iam service-accounts keys create key.json \
  --iam-account ge-alerter-deployer@$PROJECT.iam.gserviceaccount.com
base64 -w0 key.json; echo   # copy into the environment setting below, then: rm key.json
```

Add two environment variables in the Claude Code environment settings, never in git: `GCP_PROJECT_ID` and `GCP_SA_KEY`
(the base64 line, or the raw JSON). Start a new session and ask it to deploy. Delete the key in the console when you are done; the
deployed app does not use it.

If your organization blocks service account keys (`iam.disableServiceAccountKeyCreation`) or public Cloud Run services
(domain restricted sharing), use a project outside that organization or run the script yourself.

Only accounts in `ALLOWED_EMAIL_DOMAINS` can sign in, approve the Gemini Enterprise connection, or read data. The
bootstrap defaults it to `imdigital.com`; pass `ALLOWED_EMAIL_DOMAINS=other.com,imdigital.com` to change it, or an empty
value to allow any Google account.

### 3. Turn on notifications

Open the printed App URL, sign in with Google, click **Enable notifications**, and set the **Default link** to your
Gemini Enterprise app URL.

### 4. Connect Gemini Enterprise

In the Google Cloud console go to **Gemini Enterprise → Data stores → Create data store → Custom MCP server** (you need
the Discovery Engine Editor role) and enter:

| Field | Value |
| --- | --- |
| MCP server URL | `https://SERVER/mcp` |
| Authorization URL | `https://SERVER/oauth/authorize` |
| Token URL | `https://SERVER/oauth/token` |
| Client ID / Client secret | printed by the bootstrap; the secret is read with the printed `gcloud secrets` command |
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

## CI

`docs/github-workflow-ci.yml` is a ready-made GitHub Actions workflow (typecheck, tests, builds, container build). Move
it to `.github/workflows/ci.yml` and commit; it could not be pushed from the session that created this repo because
that token lacks the `workflow` scope.
