#!/usr/bin/env bash
# Removes everything scripts/bootstrap.sh created for one installation, and nothing else: the project, its default
# database and hosting site, Firebase Auth users and other apps are left alone.
#
# Dry run by default: it lists what it would delete. To delete, set CONFIRM to the installation's APP_NAME
# (the database and hosting site id it prints), e.g.
#   GCP_PROJECT_ID=my-project ./scripts/teardown.sh
#   GCP_PROJECT_ID=my-project CONFIRM=my-project-agent-notifications ./scripts/teardown.sh
#
# Same naming variables and credentials as bootstrap.sh: GCP_PROJECT_ID, REGION, SLUG, DISPLAY_NAME, APP_NAME,
# GCP_SA_KEY. Deleted database and hosting site ids cannot be reused straight away, so reinstall under a new SLUG
# or APP_NAME if you need to start again quickly.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${REGION:-us-central1}"
SLUG="${SLUG:-agent-notifications}"
DISPLAY_NAME="${DISPLAY_NAME:-Agent Notifications}"
SERVICE="$SLUG-server"
RUNTIME_SA_NAME="$SLUG-run"
SECRET_NAME="$SLUG-oauth-client-secret"
RUNTIME_SA="$RUNTIME_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
APP_NAME="${APP_NAME:-$(printf '%s' "${PROJECT_ID}-$SLUG" | tr 'A-Z_' 'a-z-' | cut -c1-30 | sed 's/-*$//')}"
DELETE=false
[[ "${CONFIRM:-}" == "$APP_NAME" ]] && DELETE=true

if [[ -n "${GCP_SA_KEY:-}" ]]; then
  KEY_FILE="$(mktemp)"
  chmod 600 "$KEY_FILE"
  trap 'rm -f "$KEY_FILE"' EXIT
  if [[ "$GCP_SA_KEY" =~ ^[[:space:]]*\{ ]]; then printf '%s' "$GCP_SA_KEY" > "$KEY_FILE"; else printf '%s' "$GCP_SA_KEY" | base64 -d > "$KEY_FILE"; fi
  unset CLOUDSDK_AUTH_ACCESS_TOKEN
  gcloud auth activate-service-account --key-file "$KEY_FILE" --quiet >/dev/null
fi
gcloud config set project "$PROJECT_ID" --quiet >/dev/null 2>&1
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"

api() { # api METHOD URL [JSON]
  curl -sS -X "$1" "$2" -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" -H "X-Goog-User-Project: $PROJECT_ID" ${3:+-d "$3"}
}
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s||'{}');const r=($1);process.stdout.write(r===undefined||r===null?'':typeof r==='string'?r:JSON.stringify(r))})"; }
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
step() { # step "description" command...
  if $DELETE; then echo "  $1"; shift; "$@"; else echo "  would: $1"; fi
}

$DELETE && log "Deleting installation $APP_NAME from $PROJECT_ID" \
        || log "Dry run for installation $APP_NAME in $PROJECT_ID (set CONFIRM=$APP_NAME to delete)"

log "Cloud Run service $SERVICE and its images"
if gcloud run services describe "$SERVICE" --region "$REGION" >/dev/null 2>&1; then
  step "delete Cloud Run service $SERVICE" gcloud run services delete "$SERVICE" --region "$REGION" --quiet
else echo "  not found"; fi
if gcloud artifacts packages describe "$SERVICE" --repository cloud-run-source-deploy --location "$REGION" >/dev/null 2>&1; then
  step "delete container images cloud-run-source-deploy/$SERVICE" \
    gcloud artifacts packages delete "$SERVICE" --repository cloud-run-source-deploy --location "$REGION" --quiet
else echo "  no images"; fi

log "OAuth client secret $SECRET_NAME"
if gcloud secrets describe "$SECRET_NAME" >/dev/null 2>&1; then
  step "delete secret $SECRET_NAME" gcloud secrets delete "$SECRET_NAME" --quiet
else echo "  not found"; fi

log "Runtime service account $RUNTIME_SA"
if gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1; then
  for role in roles/firebasedatabase.admin roles/firebasecloudmessaging.admin roles/firebaseauth.viewer; do
    step "remove $role" gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
      --member "serviceAccount:$RUNTIME_SA" --role "$role" --condition=None --quiet >/dev/null
  done
  step "delete service account" gcloud iam service-accounts delete "$RUNTIME_SA" --quiet
else echo "  not found"; fi

log "Hosting site $APP_NAME"
if api GET "https://firebasehosting.googleapis.com/v1beta1/projects/$PROJECT_ID/sites/$APP_NAME" | grep -q '"name"'; then
  delete_site() { api DELETE "https://firebasehosting.googleapis.com/v1beta1/projects/$PROJECT_ID/sites/$APP_NAME" >/dev/null; }
  step "delete hosting site $APP_NAME ($APP_NAME.web.app)" delete_site
else echo "  not found"; fi

log "Realtime Database instance $APP_NAME"
DB_NAME="$(api GET "https://firebasedatabase.googleapis.com/v1beta/projects/$PROJECT_NUMBER/locations/-/instances" \
  | APP_NAME="$APP_NAME" json "(v.instances||[]).find(i=>i.name.endsWith('/instances/'+process.env.APP_NAME) && i.type!=='DEFAULT_DATABASE')?.name")"
if [[ -n "$DB_NAME" ]]; then
  delete_db() {
    # Instances must be disabled before they can be deleted.
    api POST "https://firebasedatabase.googleapis.com/v1beta/$DB_NAME:disable" '{}' >/dev/null
    local out; out="$(api DELETE "https://firebasedatabase.googleapis.com/v1beta/$DB_NAME")"
    printf '%s' "$out" | grep -q '"error"' && { echo "  could not delete: $out" >&2; return 1; } || true
  }
  step "disable and delete database $APP_NAME (all notifications and device registrations)" delete_db
else echo "  not found"; fi

log "Firebase web app \"$DISPLAY_NAME\""
WEB_APP="$(api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps" \
  | DISPLAY_NAME="$DISPLAY_NAME" json "(v.apps||[]).find(a=>a.displayName===process.env.DISPLAY_NAME && a.state!=='DELETED')?.name")"
if [[ -n "$WEB_APP" ]]; then
  remove_app() { api POST "https://firebase.googleapis.com/v1beta1/$WEB_APP:remove" '{"immediate":true}' >/dev/null; }
  step "remove web app $WEB_APP" remove_app
else echo "  not found"; fi

log "Sign-in domains $APP_NAME.web.app and $APP_NAME.firebaseapp.com"
AUTH_CFG="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config")"
DOMAINS="$(printf '%s' "$AUTH_CFG" | SITE="$APP_NAME" json "(v.authorizedDomains||[]).filter(d=>d!==process.env.SITE+'.web.app'&&d!==process.env.SITE+'.firebaseapp.com')")"
if [[ "$DOMAINS" != "$(printf '%s' "$AUTH_CFG" | json "v.authorizedDomains||[]")" ]]; then
  remove_domains() {
    api PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=authorizedDomains" \
      "{\"authorizedDomains\":$DOMAINS}" >/dev/null
  }
  step "remove them from Firebase Auth's authorized domains" remove_domains
else echo "  not listed"; fi

cat <<MSG

------------------------------------------------------------------------------
$($DELETE && echo "Deleted what was found above." || echo "Dry run only; nothing was deleted.")

Not done by this script (no API, or not part of this installation):
  - In https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID open "Web client (auto created by
    Google Service)" and remove https://$APP_NAME.web.app from the JavaScript origins and
    https://$APP_NAME.web.app/__/auth/handler from the redirect URIs.
  - Delete the connector in Gemini Enterprise, claude.ai and Claude Code (claude mcp remove ...).
  - Each user removes the installed app from their devices.
------------------------------------------------------------------------------
MSG
