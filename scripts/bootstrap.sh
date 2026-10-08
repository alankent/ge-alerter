#!/usr/bin/env bash
# Provisions and deploys Agent Notifications into one Google Cloud / Firebase project.
# Safe to re-run: every step checks before it creates, so this is also the redeploy command.
# docs/INSTALL.md walks through the whole installation, including the console steps around this script;
# scripts/teardown.sh removes everything this script creates.
#
# Credentials, one of:
#   GCP_SA_KEY        a service account JSON key, raw or base64-encoded on one line (never commit this)
#   (none)            an already-authenticated gcloud, e.g. in Cloud Shell, or a proxy that attaches Google
#                     credentials to *.googleapis.com requests (gcloud then runs on a placeholder access token)
#
# Only gcloud, curl and node are needed: Firebase is driven through its REST APIs, not the Firebase CLI.
# Required:
#   GCP_PROJECT_ID    the project to deploy into (Firebase must be enabled on it, billing on the Blaze plan)
# Optional:
#   REGION            Cloud Run and database region (default us-central1)
#   ONLY              "server" or "web" to deploy just one half
#   FIREBASE_VAPID_KEY  your own Web Push key; the Firebase default key is used otherwise
#   SLUG              prefix for every resource this script creates (default agent-notifications): Cloud Run
#                     service <slug>-server, service account <slug>-run, secret <slug>-oauth-client-secret,
#                     OAuth client id <slug>-<project number>
#   DISPLAY_NAME      the Firebase web app's registered name, used to find it on re-runs (default Agent Notifications)
#   APP_NAME          id for this app's own database instance and hosting site (default <project>-<slug>)
#   ALLOWED_EMAIL_DOMAINS  comma-separated email domains that may sign in (default imdigital.com; set to empty to allow any)
#   ALLOWED_LINKS     comma-separated hosts notification links may point to: "host", "*.domain", optionally followed
#                     by a path prefix (default: the Gemini Enterprise web app and *.imdigital.com). Agents' other
#                     links are dropped. Set to empty to allow any link.
#   MCP_CALLBACK_PORT  localhost port Claude Code uses for its OAuth callback (default 8765); its redirect URI is allow-listed
#
# The app never touches the project's default database or default hosting site, so it can share a
# project with other apps.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${REGION:-us-central1}"
ALLOWED_EMAIL_DOMAINS="${ALLOWED_EMAIL_DOMAINS-imdigital.com}"
ALLOWED_LINKS="${ALLOWED_LINKS-vertexaisearch.cloud.google.com,*.imdigital.com}"
MCP_CALLBACK_PORT="${MCP_CALLBACK_PORT:-8765}"
# Gemini Enterprise's fixed redirect, Claude's connector callbacks (claude.ai today, claude.com announced), and Claude
# Code's local callback, so the same OAuth client serves all of them.
OAUTH_REDIRECT_URIS="https://vertexaisearch.cloud.google.com/oauth-redirect,https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,http://localhost:$MCP_CALLBACK_PORT/callback"
SLUG="${SLUG:-agent-notifications}"
DISPLAY_NAME="${DISPLAY_NAME:-Agent Notifications}"
SERVICE="$SLUG-server"
RUNTIME_SA_NAME="$SLUG-run"
SECRET_NAME="$SLUG-oauth-client-secret"
RUNTIME_SA="$RUNTIME_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Database instance and hosting site ids are global, 6-30 chars, lowercase letters, digits and hyphens.
APP_NAME="${APP_NAME:-$(printf '%s' "${PROJECT_ID}-$SLUG" | tr 'A-Z_' 'a-z-' | cut -c1-30 | sed 's/-*$//')}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- credentials
if [[ -n "${GCP_SA_KEY:-}" ]]; then
  KEY_FILE="$(mktemp)"
  chmod 600 "$KEY_FILE"
  trap 'rm -f "$KEY_FILE"' EXIT
  if [[ "$GCP_SA_KEY" =~ ^[[:space:]]*\{ ]]; then
    printf '%s' "$GCP_SA_KEY" > "$KEY_FILE"
  else
    printf '%s' "$GCP_SA_KEY" | base64 -d > "$KEY_FILE"
  fi
  # A stale token in the environment would override the key.
  unset CLOUDSDK_AUTH_ACCESS_TOKEN
  gcloud auth activate-service-account --key-file "$KEY_FILE" --quiet >/dev/null
  export GOOGLE_APPLICATION_CREDENTIALS="$KEY_FILE"
fi
gcloud config set project "$PROJECT_ID" --quiet >/dev/null 2>&1
log "Deploying as $(gcloud config get-value account 2>/dev/null) into $PROJECT_ID ($REGION)"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
api() { # api METHOD URL [JSON]
  curl -sS -X "$1" "$2" -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" -H "X-Goog-User-Project: $PROJECT_ID" ${3:+-d "$3"}
}
# Waits for a Firebase Management long-running operation and prints its response.
wait_op() { # wait_op OPERATION_NAME
  local op
  for _ in $(seq 1 60); do
    op="$(api GET "https://firebase.googleapis.com/v1beta1/$1")"
    if printf '%s' "$op" | json "v.done===true?'y':''" | grep -q y; then
      printf '%s' "$op" | json "v.error?(()=>{throw new Error(JSON.stringify(v.error))})():v.response"
      return
    fi
    sleep 2
  done
  echo "Timed out waiting for $1" >&2; return 1
}
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s||'{}');const r=($1);process.stdout.write(r===undefined||r===null?'':typeof r==='string'?r:JSON.stringify(r))})"; }

# ------------------------------------------------------------------- APIs
log "Enabling APIs"
gcloud services enable --quiet \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  firebase.googleapis.com firebasedatabase.googleapis.com firebasehosting.googleapis.com \
  identitytoolkit.googleapis.com fcm.googleapis.com fcmregistrations.googleapis.com

# --------------------------------------------------------------- Firebase
log "Making sure Firebase is enabled on the project"
if ! api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID" | grep -q '"projectId"'; then
  OP="$(api POST "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID:addFirebase" '{}' | json "v.name")"
  [[ -n "$OP" ]] || { echo "Could not add Firebase to the project" >&2; exit 1; }
  wait_op "$OP" >/dev/null
fi

log "Realtime Database instance $APP_NAME (the project's default database is left alone)"
DB_LIST="$(api GET "https://firebasedatabase.googleapis.com/v1beta/projects/$PROJECT_NUMBER/locations/-/instances")"
DATABASE_URL="$(printf '%s' "$DB_LIST" | APP_NAME="$APP_NAME" json "(v.instances||[]).find(i=>i.name.endsWith('/instances/'+process.env.APP_NAME))?.databaseUrl")"
if [[ -z "$DATABASE_URL" ]]; then
  CREATED="$(api POST "https://firebasedatabase.googleapis.com/v1beta/projects/$PROJECT_NUMBER/locations/$REGION/instances?databaseId=$APP_NAME" '{"type":"USER_DATABASE"}')"
  DATABASE_URL="$(printf '%s' "$CREATED" | json "v.databaseUrl")"
  [[ -n "$DATABASE_URL" ]] || { echo "Could not create the database (set APP_NAME if the id is taken): $CREATED" >&2; exit 1; }
fi
echo "  $DATABASE_URL"

log "Firebase web app"
# The web app's registered display name is how re-runs find it.
APP_ID="$(api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps" | DISPLAY_NAME="$DISPLAY_NAME" json "(v.apps||[]).find(a=>a.displayName===process.env.DISPLAY_NAME && a.state!=='DELETED')?.appId")"
if [[ -z "$APP_ID" ]]; then
  OP="$(api POST "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps" "{\"displayName\":\"$DISPLAY_NAME\"}" | json "v.name")"
  [[ -n "$OP" ]] || { echo "Could not create the Firebase web app" >&2; exit 1; }
  APP_ID="$(wait_op "$OP" | json "v.appId")"
fi
WEB_CONFIG="$(api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps/$APP_ID/config")"
echo "  $APP_ID"

log "Hosting site $APP_NAME (the project's default site is left alone)"
SITE="$APP_NAME"
if ! api GET "https://firebasehosting.googleapis.com/v1beta1/projects/$PROJECT_ID/sites/$SITE" | grep -q '"name"'; then
  RESULT="$(api POST "https://firebasehosting.googleapis.com/v1beta1/projects/$PROJECT_ID/sites?siteId=$SITE" '{}')"
  printf '%s' "$RESULT" | grep -q '"name"' || { echo "Could not create the hosting site (set APP_NAME if the id is taken): $RESULT" >&2; exit 1; }
fi
WEB_URL="https://$SITE.web.app"
# Cloud Run's deterministic URL format, so we know it before the first deploy.
PUBLIC_URL="https://$SERVICE-$PROJECT_NUMBER.$REGION.run.app"
echo "  $WEB_URL"

log "Allowing sign-in from $SITE.web.app"
AUTH_CFG="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config")"
if printf '%s' "$AUTH_CFG" | grep -q '"authorizedDomains"'; then
  DOMAINS="$(printf '%s' "$AUTH_CFG" | SITE="$SITE" json "[...new Set([...(v.authorizedDomains||[]), process.env.SITE+'.web.app', process.env.SITE+'.firebaseapp.com'])]")"
  api PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=authorizedDomains" "{\"authorizedDomains\":$DOMAINS}" >/dev/null
  echo "  ok"
else
  echo "  Firebase Authentication is not set up yet. Enable Google sign-in in the console, then re-run this script."
fi

# ----------------------------------------------------------------- server
if [[ "${ONLY:-}" != "web" ]]; then
  log "OAuth client secret for Gemini Enterprise (Secret Manager: $SECRET_NAME)"
  if ! gcloud secrets describe "$SECRET_NAME" >/dev/null 2>&1; then
    openssl rand -base64 33 | tr -d '\n' | gcloud secrets create "$SECRET_NAME" --data-file=- --replication-policy=automatic --quiet
  fi

  log "Runtime service account"
  gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$RUNTIME_SA_NAME" --display-name "$DISPLAY_NAME (Cloud Run)" --quiet
  for role in roles/firebasedatabase.admin roles/firebasecloudmessaging.admin roles/firebaseauth.viewer; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$RUNTIME_SA" --role "$role" --condition=None --quiet >/dev/null
  done
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null
  # Source deploys build with the default compute service account.
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" --role roles/run.builder --condition=None --quiet >/dev/null

  log "Deploying the MCP server to Cloud Run (the build takes a few minutes)"
  gcloud run deploy "$SERVICE" --quiet \
    --region "$REGION" --source "$ROOT/server" \
    --service-account "$RUNTIME_SA" \
    --allow-unauthenticated \
    --min-instances 0 --max-instances 2 --memory 512Mi --cpu 1 \
    --set-env-vars "^@^STORE=firebase@FIREBASE_DATABASE_URL=$DATABASE_URL@FIREBASE_PROJECT_ID=$PROJECT_ID@PUBLIC_URL=$PUBLIC_URL@WEB_URL=$WEB_URL@OAUTH_CLIENT_ID=$SLUG-$PROJECT_NUMBER@OAUTH_REDIRECT_URIS=$OAUTH_REDIRECT_URIS@ALLOWED_EMAIL_DOMAINS=$ALLOWED_EMAIL_DOMAINS@ALLOWED_LINKS=$ALLOWED_LINKS" \
    --set-secrets "OAUTH_CLIENT_SECRET=$SECRET_NAME:latest"
  if curl -fsS --max-time 30 "$PUBLIC_URL/healthz" >/dev/null 2>&1; then echo "  health check ok"
  else echo "  (could not reach $PUBLIC_URL/healthz from here; check it in a browser)"; fi
fi

# -------------------------------------------------------------------- web
if [[ "${ONLY:-}" != "server" ]]; then
  log "Building the PWA"
  # The sign-in helper is served from the app's own origin (Hosting provides /__/auth on every site) rather than
  # <project>.firebaseapp.com: a cross-origin auth domain fails in browsers that partition storage and in embedded
  # webviews with "missing initial state". Google's OAuth client must list this origin's handler, see the summary.
  printf '%s' "$WEB_CONFIG" | AUTH_DOMAIN="$SITE.web.app" DATABASE_URL="$DATABASE_URL" PUBLIC_URL="$PUBLIC_URL" ALLOWED_EMAIL_DOMAINS="$ALLOWED_EMAIL_DOMAINS" OUT="$ROOT/web/.env.production.local" node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const c=JSON.parse(s), e=process.env;
      const lines={
        NEXT_PUBLIC_FIREBASE_API_KEY:c.apiKey,
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:e.AUTH_DOMAIN,
        NEXT_PUBLIC_FIREBASE_DATABASE_URL:e.DATABASE_URL,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID:c.projectId,
        NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:c.messagingSenderId,
        NEXT_PUBLIC_FIREBASE_APP_ID:c.appId,
        NEXT_PUBLIC_FIREBASE_VAPID_KEY:e.FIREBASE_VAPID_KEY||'',
        NEXT_PUBLIC_API_URL:e.PUBLIC_URL,
        NEXT_PUBLIC_ALLOWED_EMAIL_DOMAINS:e.ALLOWED_EMAIL_DOMAINS,
      };
      require('fs').writeFileSync(e.OUT,Object.entries(lines).map(([k,v])=>k+'='+(v??'')).join('\n')+'\n');
    })"
  (cd "$ROOT" && npm install --no-audit --no-fund --loglevel=error && NEXT_TELEMETRY_DISABLED=1 npm run build --workspace web)

  log "Deploying hosting to $SITE"
  # NODE_USE_ENV_PROXY makes fetch honour HTTPS_PROXY (a no-op when none is set).
  (cd "$ROOT" && NODE_USE_ENV_PROXY=1 GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)" \
    node --disable-warning=UNDICI-EHPA scripts/deploy-hosting.mjs "$SITE" "$ROOT/web/out")

  log "Deploying database rules to $APP_NAME"
  (cd "$ROOT" && ALLOWED_EMAIL_DOMAINS="$ALLOWED_EMAIL_DOMAINS" node scripts/gen-rules.mjs)
  # The rules endpoint lives on firebaseio.com, not googleapis.com, and wants an OAuth token.
  RULES_RESULT="$(curl -sS -X PUT "$DATABASE_URL/.settings/rules.json" \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" --data-binary "@$ROOT/database.rules.json")"
  if printf '%s' "$RULES_RESULT" | grep -q '"status" *: *"ok"'; then
    echo "  ok"
  else
    # A proxy that only covers googleapis.com cannot reach firebaseio.com with credentials. Run the same
    # PUT from a one-shot Cloud Build step as the runtime service account (which already administers the
    # database); the build runs for seconds and nothing stays behind.
    echo "  direct upload failed ($RULES_RESULT); retrying from Cloud Build as $RUNTIME_SA"
    # No source upload (the runtime account cannot read the deployer's bucket); the rules travel base64-encoded
    # in a substitution instead.
    BUILD_CFG="$(mktemp)"
    cat > "$BUILD_CFG" <<'YAML'
steps:
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: bash
    args:
      - -ec
      - |
        printf '%s' "$_RULES_B64" | base64 -d > rules.json
        curl -fsS -X PUT "$_DATABASE_URL/.settings/rules.json" \
          -H "Authorization: Bearer $(gcloud auth print-access-token)" --data-binary @rules.json
serviceAccount: projects/$PROJECT_ID/serviceAccounts/$_RUNTIME_SA
options:
  logging: NONE
YAML
    gcloud builds submit --no-source --config "$BUILD_CFG" --region "$REGION" --quiet \
      --substitutions "_DATABASE_URL=$DATABASE_URL,_RUNTIME_SA=$RUNTIME_SA,_RULES_B64=$(base64 -w0 "$ROOT/database.rules.json")" >/dev/null
    rm -f "$BUILD_CFG"
    echo "  ok (via Cloud Build)"
  fi
fi

# ---------------------------------------------------------------- summary
GOOGLE_SIGNIN="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/defaultSupportedIdpConfigs/google.com" | json "v.enabled===true?'enabled':'NOT enabled'" 2>/dev/null || echo unknown)"

cat <<MSG

------------------------------------------------------------------------------
Agent Notifications is deployed.

  App:          $WEB_URL
  MCP server:   $PUBLIC_URL

Google sign-in in Firebase Auth: $GOOGLE_SIGNIN
$( [[ "$GOOGLE_SIGNIN" != enabled ]] && echo "  Enable it: https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers" )
Once, in https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID open the OAuth 2.0 client that Firebase
created ("Web client (auto created by Google Service)") and add
  Authorized JavaScript origin:  $WEB_URL
  Authorized redirect URI:       $WEB_URL/__/auth/handler
so Google sign-in can return to the app's own domain. (No API exists for this.)

Gemini Enterprise custom MCP server data store:
  MCP server URL:      $PUBLIC_URL/mcp
  Authorization URL:   $PUBLIC_URL/oauth/authorize
  Token URL:           $PUBLIC_URL/oauth/token
  Client ID:           $SLUG-$PROJECT_NUMBER
  Client secret:       gcloud secrets versions access latest --secret $SECRET_NAME --project $PROJECT_ID
  Scopes:              notifications

Try it from Claude:
  claude.ai / Claude Code web: Customize > Connectors > Add custom connector, URL $PUBLIC_URL/mcp,
    Advanced settings: the client ID and secret above.
  Claude Code on a laptop (the secret is prompted for, then kept in your keychain):
    claude mcp add --transport http --client-id $SLUG-$PROJECT_NUMBER --client-secret \
      --callback-port $MCP_CALLBACK_PORT agent-notifications $PUBLIC_URL/mcp
    then run /mcp and sign in.
------------------------------------------------------------------------------
MSG
