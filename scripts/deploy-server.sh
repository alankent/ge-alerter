#!/usr/bin/env bash
# Deploys the MCP server to Cloud Run (scales to zero, so it costs nothing while idle).
#
# Required environment:
#   PROJECT_ID            Google Cloud / Firebase project id
#   OAUTH_CLIENT_ID       opaque id you will paste into Gemini Enterprise
#   OAUTH_CLIENT_SECRET   opaque secret you will paste into Gemini Enterprise
#   WEB_URL               PWA origin, e.g. https://PROJECT_ID.web.app
# Optional:
#   REGION (default us-central1), SERVICE (default ge-alerter-server), PUBLIC_URL (default: the service URL)
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${OAUTH_CLIENT_ID:?set OAUTH_CLIENT_ID}"
: "${OAUTH_CLIENT_SECRET:?set OAUTH_CLIENT_SECRET}"
: "${WEB_URL:?set WEB_URL}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-ge-alerter-server}"
DATABASE_URL="${FIREBASE_DATABASE_URL:-https://${PROJECT_ID}-default-rtdb.firebaseio.com}"

cd "$(dirname "$0")/../server"

# First deploy: we do not know the URL yet, so deploy, read it back, then set PUBLIC_URL.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" \
  --source . \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --memory 512Mi --cpu 1 \
  --set-env-vars "STORE=firebase,FIREBASE_DATABASE_URL=${DATABASE_URL},FIREBASE_PROJECT_ID=${PROJECT_ID},WEB_URL=${WEB_URL},OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID},OAUTH_CLIENT_NAME=Gemini Enterprise" \
  --update-secrets "OAUTH_CLIENT_SECRET=ge-alerter-oauth-client-secret:latest" 2>/dev/null || {
  echo "Secret ge-alerter-oauth-client-secret not found; creating it and retrying." >&2
  printf '%s' "$OAUTH_CLIENT_SECRET" | gcloud secrets create ge-alerter-oauth-client-secret --project "$PROJECT_ID" --data-file=- --replication-policy=automatic
  SA="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')-compute@developer.gserviceaccount.com"
  gcloud secrets add-iam-policy-binding ge-alerter-oauth-client-secret --project "$PROJECT_ID" --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor >/dev/null
  gcloud run deploy "$SERVICE" \
    --project "$PROJECT_ID" --region "$REGION" \
    --source . \
    --allow-unauthenticated \
    --min-instances 0 --max-instances 2 --memory 512Mi --cpu 1 \
    --set-env-vars "STORE=firebase,FIREBASE_DATABASE_URL=${DATABASE_URL},FIREBASE_PROJECT_ID=${PROJECT_ID},WEB_URL=${WEB_URL},OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID},OAUTH_CLIENT_NAME=Gemini Enterprise" \
    --update-secrets "OAUTH_CLIENT_SECRET=ge-alerter-oauth-client-secret:latest"
}

URL="${PUBLIC_URL:-$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')}"
gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --update-env-vars "PUBLIC_URL=${URL}" >/dev/null

cat <<MSG

Deployed. Enter these in Gemini Enterprise (custom MCP server data store):

  MCP server URL:     ${URL}/mcp
  Authorization URL:  ${URL}/oauth/authorize
  Token URL:          ${URL}/oauth/token
  Client ID:          ${OAUTH_CLIENT_ID}
  Client secret:      (the value you set)
  Scopes:             notifications

And set NEXT_PUBLIC_API_URL=${URL} in web/.env.local before building the PWA.
MSG
