# Installing Agent Notifications

This guide installs Agent Notifications into a Google Cloud project with Firebase, connects it to Gemini Enterprise
(and optionally Claude), and gets users set up. Allow about 30 minutes the first time.

The installation is one idempotent script, `scripts/bootstrap.sh`, plus a few console steps that have no API.
`scripts/teardown.sh` removes everything the script created.

## What gets created

Everything is named from one prefix, `SLUG` (default `agent-notifications`). With project `my-project`:

| Resource | Name |
| --- | --- |
| Cloud Run service (MCP + OAuth server) | `agent-notifications-server` |
| Firebase Hosting site (the app) | `my-project-agent-notifications` → `https://my-project-agent-notifications.web.app` |
| Realtime Database instance | `my-project-agent-notifications` |
| Firebase web app | "Agent Notifications" |
| Secret Manager secret (OAuth client secret) | `agent-notifications-oauth-client-secret` |
| Runtime service account | `agent-notifications-run@my-project.iam.gserviceaccount.com` |
| OAuth client ID (a string the server checks, not a Google resource) | `agent-notifications-<project number>` |

The app never touches the project's default database, default hosting site or other apps, so it can share a project.
Firebase Authentication (Google sign-in) is project-wide and shared with any other apps in the project.

## 1. Prerequisites (once per project)

1. **A Google Cloud project with Firebase.** In the [Firebase console](https://console.firebase.google.com) create a
   project, or add Firebase to an existing Google Cloud project. It does not need to be the project where Gemini
   Enterprise is installed; see "Where to deploy" in `docs/ARCHITECTURE.md`.
2. **The Blaze plan.** Cloud Run needs billing enabled. Usage stays inside the free tiers; there is no always-on
   infrastructure.
3. **Google sign-in.** Firebase console → **Authentication → Get started → Sign-in method → Google → Enable.**
4. **Organization policies.** The server must be a public Cloud Run service (it is protected by OAuth, not IAM). If your
   organization enforces domain restricted sharing, or blocks service account keys and you want to use one, use a
   project outside that organization.

## 2. Credentials for running the script

The script needs an identity with Owner (or equivalent) on the project, and `gcloud`, `curl` and `node` 20+. It does
not need the Firebase CLI. Pick one:

- **Cloud Shell** (simplest). [Cloud Shell](https://shell.cloud.google.com) is already signed in as you.
- **A service account key**, for example for a Claude Code cloud session. In Cloud Shell:

  ```bash
  PROJECT=my-project
  gcloud iam service-accounts create agent-notifications-deployer --project $PROJECT
  gcloud projects add-iam-policy-binding $PROJECT \
    --member serviceAccount:agent-notifications-deployer@$PROJECT.iam.gserviceaccount.com --role roles/owner
  gcloud iam service-accounts keys create key.json \
    --iam-account agent-notifications-deployer@$PROJECT.iam.gserviceaccount.com
  base64 -w0 key.json; echo   # paste into GCP_SA_KEY below, then: rm key.json
  ```

  Set `GCP_PROJECT_ID` and `GCP_SA_KEY` (the base64 line or the raw JSON) in the Claude Code environment settings,
  never in git. Delete the key when you are done; the deployed app does not use it.
- **A network secret.** A Claude Code environment can attach the service account's tokens to `*.googleapis.com`
  requests instead of holding a key. Set only `GCP_PROJECT_ID`. Two differences: the database rules are uploaded from a
  short Cloud Build step (the proxy does not cover `firebaseio.com`), and the final health check cannot reach `run.app`
  from the session, so check it in a browser.

## 3. Run the bootstrap

```bash
git clone https://github.com/alankent/ge-alerter && cd ge-alerter
GCP_PROJECT_ID=my-project ./scripts/bootstrap.sh
```

It enables the APIs, creates the resources above, deploys the server and the app, and ends with a summary of the URLs
and the values for Gemini Enterprise. Re-run it any time to redeploy; every step checks before it creates.

Settings (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `GCP_PROJECT_ID` | required | Project to install into. |
| `REGION` | `us-central1` | Cloud Run and database region. |
| `SLUG` | `agent-notifications` | Prefix for every resource name. |
| `APP_NAME` | `<project>-<slug>` | Database instance and hosting site id (globally unique, 6–30 chars). |
| `ALLOWED_EMAIL_DOMAINS` | `imdigital.com` | Who may sign in, connect and read data. Empty allows any Google account. |
| `ALLOWED_LINKS` | `vertexaisearch.cloud.google.com,*.imdigital.com` | Where notification links may point (see step 6). Empty allows any link. |
| `MCP_CALLBACK_PORT` | `8765` | Port of Claude Code's local OAuth callback. |
| `ONLY` | | `server` or `web` to redeploy one half. |
| `FIREBASE_VAPID_KEY` | Firebase default | Your own Web Push key, if you want one. |

Settings are applied on every run, so pass the same values each time (or change the defaults in the script and
commit them).

## 4. Allow sign-in on the app's domain (console, once)

The app signs users in through its own domain, which avoids failures in browsers that partition storage. Google's OAuth
client has to accept that domain, and there is no API for this:

1. Open [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) in the project.
2. Open the OAuth 2.0 client **"Web client (auto created by Google Service)"**.
3. Add **Authorized JavaScript origin** `https://<APP_NAME>.web.app`.
4. Add **Authorized redirect URI** `https://<APP_NAME>.web.app/__/auth/handler`.
5. Save. It can take a few minutes to apply.

Without this, sign-in fails with `Error 400: redirect_uri_mismatch`.

## 5. Check it works

Open `https://<APP_NAME>.web.app`, sign in, click **Turn on notifications**, then **Send test**. A notification should
appear within seconds. **Notification history and advanced settings** at the bottom of the page shows the inbox and
lets you set a **Default link**, the page a notification opens when the agent gives none (your Gemini Enterprise inbox
is a good choice).

## 6. Connect Gemini Enterprise

In the Google Cloud console go to **Gemini Enterprise → Data stores → Create data store → Custom MCP server** (you need
the Discovery Engine Editor role; an organization admin may first need to allow custom MCP servers). Enter:

| Field | Value |
| --- | --- |
| Name | Agent Notifications |
| MCP server URL | `https://<SERVICE URL>/mcp` |
| Authorization URL | `https://<SERVICE URL>/oauth/authorize` |
| Token URL | `https://<SERVICE URL>/oauth/token` |
| Client ID | `agent-notifications-<project number>` (printed by the bootstrap) |
| Client secret | `gcloud secrets versions access latest --secret agent-notifications-oauth-client-secret --project <project>` |
| Scopes | `notifications` |
| PKCE | enable (S256) |
| HTTP Basic | either; the server accepts both |

Gemini Enterprise's redirect URI (`https://vertexaisearch.cloud.google.com/oauth-redirect`) is already allowed by the
server. Field labels move as the product evolves; follow Google's current
[custom MCP server guide](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server).

Then **enable the actions** (custom MCP actions start disabled): `send_notification`, `get_setup_instructions`, and
optionally `list_notifications` and `mark_notification_read`.

How the tools behave in Gemini Enterprise:

- **No approval prompts for notifications.** Gemini Enterprise asks the user to confirm any action whose tool is not
  annotated read-only, which would leave scheduled runs waiting. `send_notification` is annotated read-only, since its
  only effect is a notification to the user who connected. Gemini Enterprise reads annotations when it imports actions,
  so after a server upgrade that changes tools, re-import the connector's actions.
- **Links are limited to an allow-list.** Because nobody confirms the call, the server only accepts notification links
  to `ALLOWED_LINKS` (https only; the app itself is always allowed). Other links are dropped, the notification still
  arrives and opens the user's default link, and the tool result tells the agent. Entries are hosts, `*.domain`
  wildcards (which include the domain itself), or either with a path prefix, such as
  `vertexaisearch.cloud.google.com/home/cid/<your app id>/` to allow only your own Gemini Enterprise app.
- **Agents can find the setup instructions.** `get_setup_instructions` returns the app and instructions URLs and the
  steps for a given device, and `send_notification` tells the agent to use it when the user has no device set up.

The first time an agent uses the connector, the user is sent to the app's consent page ("Allow Gemini Enterprise to
send you notifications?"). They sign in with their work account and click **Allow**. The token is bound to that user,
so each person's agents notify only that person.

## 7. Connect Claude (optional)

The same OAuth client works from Claude; the server already allows Claude's callback URLs.

- **claude.ai, the Claude apps and Claude Code on the web:** [Customize → Connectors](https://claude.ai/customize/connectors)
  → **Add custom connector**. Name it Agent Notifications, enter `https://<SERVICE URL>/mcp`, and under **Advanced
  settings** the client ID and secret (the server does not support dynamic client registration). Connect and allow.
  New Claude Code web sessions then have the tools.
- **Claude Code on a computer** (version 2.1.231 or later):

  ```bash
  claude mcp add --transport http --client-id agent-notifications-<project number> --client-secret \
    --callback-port 8765 agent-notifications https://<SERVICE URL>/mcp
  ```

  It prompts for the secret and keeps it in your keychain. Run `/mcp`, pick **agent-notifications** and sign in.

## 8. Use it from agents and workflows

In Agent Designer or Workflow Builder give the agent the Agent Notifications tools and tell it when to notify, e.g.:

> When you have finished, call `send_notification` with a one-line title, a short summary in `body`, the link to the
> result as `url` if there is one, and `tags: ["weekly-digest"]`. If something needs my decision, set
> `priority: "high"`. If it reports that no device received it, call `get_setup_instructions` and tell me the steps.

Anything that is not an MCP client can call the REST endpoint with the same bearer token:

```bash
curl -X POST https://<SERVICE URL>/api/notify \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Weekly digest ready","body":"3 competitor updates","url":"https://..."}'
```

Scheduled Gemini Enterprise agents run on the user's credentials, which expire every 14 days unless refreshed from the
Agent Gallery or the Schedule tab.

## 9. Roll out to users

Send users two links:

- `https://<APP_NAME>.web.app/install`: step-by-step instructions for iPhone and iPad, Windows, Mac, Android and other
  systems. No sign-in needed.
- `https://<APP_NAME>.web.app`: the app itself. On a computer: sign in, **Turn on notifications**, **Send test**, and
  optionally **Install app**. On iPhone and iPad, notifications only work from the Home Screen app: open the link in
  Safari, **Share → Add to Home Screen**, then open **Agents** from the Home Screen and turn notifications on there.

Each user sets up every device where they want notifications. The consent page also links to the setup page, and
agents can relay the steps with `get_setup_instructions`.

## 10. Uninstall

```bash
GCP_PROJECT_ID=my-project ./scripts/teardown.sh                                        # lists what it would delete
GCP_PROJECT_ID=my-project CONFIRM=my-project-agent-notifications ./scripts/teardown.sh  # deletes it
```

It removes the Cloud Run service and its images, the secret, the runtime service account and its roles, the hosting
site, the database (all notifications and device registrations), the Firebase web app and the app's sign-in domains.
It does not touch the project, Firebase Authentication users or other apps. Afterwards, by hand: remove the app's origin
and redirect URI from the OAuth client (step 4), delete the connectors in Gemini Enterprise and Claude, and ask users to
remove the installed app. Use the same `SLUG`/`APP_NAME` you installed with; deleted database and site ids cannot be
reused immediately.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Error 400: redirect_uri_mismatch` at sign-in | Step 4 not done, or done on a different OAuth client. |
| "Unable to process request due to missing initial state" | Sign-in went through `<project>.firebaseapp.com`. The bootstrap sets the app's own domain; redeploy the web half (`ONLY=web`). |
| Scheduled agent pauses for approval | The connector's actions were imported before `send_notification` was read-only. Re-import them. |
| Agent says no device received the notification | The user has not turned on notifications on any device; send them to `/install`. |
| iPhone or iPad says the browser does not support notifications | It is open in a browser tab. Add to Home Screen from Safari and use the Home Screen app. |
| Notification link opens the default link instead | The agent's link was not on `ALLOWED_LINKS`; add the host and redeploy the server. |
| "Index not defined" errors from the server | Database rules are out of date; redeploy the web half, which uploads them. |
