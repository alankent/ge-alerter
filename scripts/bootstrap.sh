#!/usr/bin/env bash
# Provisions and deploys GE Alerter into one Google Cloud / Firebase project.
# Safe to re-run: every step checks before it creates, so this is also the redeploy command.
#
# Credentials, one of:
#   GCP_SA_KEY        a service account JSON key, raw or base64-encoded on one line (never commit this)
#   (none)            an already-authenticated gcloud, e.g. in Cloud Shell
# Required:
#   GCP_PROJECT_ID    the project to deploy into (Firebase must be enabled on it, billing on the Blaze plan)
# Optional:
#   REGION            Cloud Run and database region (default us-central1)
#   ONLY              "server" or "web" to deploy just one half
#   FIREBASE_VAPID_KEY  your own Web Push key; the Firebase default key is used otherwise
#   APP_NAME          id for this app's own database instance and hosting site (default <project>-ge-alerter)
#
# The app never touches the project's default database or default hosting site, so it can share a
# project with other apps.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE=ge-alerter-server
RUNTIME_SA_NAME=ge-alerter-run
SECRET_NAME=ge-alerter-oauth-client-secret
FIREBASE="npx -y firebase-tools@15.32.1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Database instance and hosting site ids are global, 6-30 chars, lowercase letters, digits and hyphens.
APP_NAME="${APP_NAME:-$(printf '%s' "${PROJECT_ID}-ge-alerter" | tr 'A-Z_' 'a-z-' | cut -c1-30 | sed 's/-*$//')}"

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
  $FIREBASE projects:addfirebase "$PROJECT_ID" --non-interactive
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
APP_ID="$(api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps" | json "(v.apps||[]).find(a=>a.displayName==='GE Alerter' && a.state!=='DELETED')?.appId")"
if [[ -z "$APP_ID" ]]; then
  APP_ID="$($FIREBASE apps:create WEB "GE Alerter" --project "$PROJECT_ID" --json | json "v.result.appId")"
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
  RUNTIME_SA="$RUNTIME_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
  gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 \
    || gcloud iam service-accounts create "$RUNTIME_SA_NAME" --display-name "GE Alerter (Cloud Run)" --quiet
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
    --set-env-vars "^@^STORE=firebase@FIREBASE_DATABASE_URL=$DATABASE_URL@FIREBASE_PROJECT_ID=$PROJECT_ID@PUBLIC_URL=$PUBLIC_URL@WEB_URL=$WEB_URL@OAUTH_CLIENT_ID=ge-alerter-$PROJECT_NUMBER@OAUTH_CLIENT_NAME=Gemini Enterprise" \
    --set-secrets "OAUTH_CLIENT_SECRET=$SECRET_NAME:latest"
  curl -fsS "$PUBLIC_URL/healthz" >/dev/null && echo "  health check ok"
fi

# -------------------------------------------------------------------- web
if [[ "${ONLY:-}" != "server" ]]; then
  log "Building the PWA"
  printf '%s' "$WEB_CONFIG" | DATABASE_URL="$DATABASE_URL" PUBLIC_URL="$PUBLIC_URL" OUT="$ROOT/web/.env.production.local" node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const c=JSON.parse(s), e=process.env;
      const lines={
        NEXT_PUBLIC_FIREBASE_API_KEY:c.apiKey,
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:c.authDomain,
        NEXT_PUBLIC_FIREBASE_DATABASE_URL:e.DATABASE_URL,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID:c.projectId,
        NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:c.messagingSenderId,
        NEXT_PUBLIC_FIREBASE_APP_ID:c.appId,
        NEXT_PUBLIC_FIREBASE_VAPID_KEY:e.FIREBASE_VAPID_KEY||'',
        NEXT_PUBLIC_API_URL:e.PUBLIC_URL,
      };
      require('fs').writeFileSync(e.OUT,Object.entries(lines).map(([k,v])=>k+'='+(v??'')).join('\n')+'\n');
    })"
  (cd "$ROOT" && npm install --no-audit --no-fund --loglevel=error && NEXT_TELEMETRY_DISABLED=1 npm run build --workspace web)

  log "Deploying hosting and database rules to $APP_NAME"
  (cd "$ROOT" \
    && $FIREBASE target:apply hosting app "$SITE" --project "$PROJECT_ID" >/dev/null \
    && $FIREBASE target:apply database alerts "$APP_NAME" --project "$PROJECT_ID" >/dev/null \
    && $FIREBASE deploy --only "hosting:app,database:alerts" --project "$PROJECT_ID" --non-interactive)
fi

# ---------------------------------------------------------------- summary
GOOGLE_SIGNIN="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/defaultSupportedIdpConfigs/google.com" | json "v.enabled===true?'enabled':'NOT enabled'" 2>/dev/null || echo unknown)"

cat <<MSG

------------------------------------------------------------------------------
GE Alerter is deployed.

  App:          $WEB_URL
  MCP server:   $PUBLIC_URL

Google sign-in in Firebase Auth: $GOOGLE_SIGNIN
$( [[ "$GOOGLE_SIGNIN" != enabled ]] && echo "  Enable it: https://console.firebase.google.com/project/$PROJECT_ID/authentication/providers" )

Gemini Enterprise custom MCP server data store:
  MCP server URL:      $PUBLIC_URL/mcp
  Authorization URL:   $PUBLIC_URL/oauth/authorize
  Token URL:           $PUBLIC_URL/oauth/token
  Client ID:           ge-alerter-$PROJECT_NUMBER
  Client secret:       gcloud secrets versions access latest --secret $SECRET_NAME --project $PROJECT_ID
  Scopes:              notifications
------------------------------------------------------------------------------
MSG
