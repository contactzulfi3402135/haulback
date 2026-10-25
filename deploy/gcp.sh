#!/usr/bin/env bash
# Optional Google Cloud deployment for Haulback:
#   - Go carrier-ledger stand-in as a single-instance Cloud Run service
#   - TypeScript Control Room as a Cloud Run service
#   - hourly sweep as a Cloud Run job triggered by Cloud Scheduler
#   - secrets in Secret Manager
#
# This script is for operators who already use GCP. It was NOT used for
# the free GitHub + Neon + Render + GitHub Actions path in README.md.
# Google Cloud requires a billing account even when usage stays within
# free allowances. Do not run this unless you accept that.
#
# Required environment (export first; values are never printed):
#   GCP_PROJECT       Google Cloud project id
#   DATABASE_URL      Postgres URL reachable from Cloud Run (for example Neon)
#   LEDGER_TOKEN      bearer token for the ledger GraphQL API
#   REVIEW_PASSWORD   Control Room password for DASHBOARD_USER
# Optional:
#   GCP_REGION        default us-central1
#   WORLD_SEED        default 20261025
#   DRAFT_MODEL       one-run/job default, default baseline:rules
#   DASHBOARD_USER    default operator
#   XAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / GROQ_API_KEY
#   OSS_BASE_URL      default https://api.groq.com/openai/v1
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-us-central1}"
: "${DATABASE_URL:?set DATABASE_URL}"
: "${LEDGER_TOKEN:?set LEDGER_TOKEN}"
: "${REVIEW_PASSWORD:?set REVIEW_PASSWORD}"

REPO="${REGION}-docker.pkg.dev/${PROJECT}/haulback"
LEDGER_IMG="${REPO}/ledger:latest"
AGENT_IMG="${REPO}/agent:latest"
WORLD_SEED="${WORLD_SEED:-20261025}"
DRAFT_MODEL="${DRAFT_MODEL:-baseline:rules}"
DASHBOARD_USER="${DASHBOARD_USER:-operator}"
OSS_BASE_URL="${OSS_BASE_URL:-https://api.groq.com/openai/v1}"

echo "Enabling APIs..."
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com \
  --project "$PROJECT"

echo "Ensuring Artifact Registry repository..."
gcloud artifacts repositories describe haulback --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud artifacts repositories create haulback \
    --repository-format=docker --location "$REGION" --project "$PROJECT"

echo "Building images..."
gcloud builds submit \
  --config deploy/cloudbuild.yaml \
  --substitutions="_LOCATION=${REGION}" \
  . --project "$PROJECT"

put_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT" >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" \
      --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
  fi
  echo "secret $name stored"
}

put_secret haulback-database-url "$DATABASE_URL"
put_secret haulback-ledger-token "$LEDGER_TOKEN"
put_secret haulback-review-password "$REVIEW_PASSWORD"
[ -n "${XAI_API_KEY:-}" ] && put_secret haulback-xai-key "$XAI_API_KEY"
[ -n "${ANTHROPIC_API_KEY:-}" ] && put_secret haulback-anthropic-key "$ANTHROPIC_API_KEY"
[ -n "${OPENAI_API_KEY:-}" ] && put_secret haulback-openai-key "$OPENAI_API_KEY"
[ -n "${GROQ_API_KEY:-}" ] && put_secret haulback-groq-key "$GROQ_API_KEY"

LEDGER_SECRETS="DATABASE_URL=haulback-database-url:latest,LEDGER_TOKEN=haulback-ledger-token:latest"
AGENT_SECRETS="${LEDGER_SECRETS},REVIEW_PASSWORD=haulback-review-password:latest"
[ -n "${XAI_API_KEY:-}" ] && AGENT_SECRETS="${AGENT_SECRETS},XAI_API_KEY=haulback-xai-key:latest"
[ -n "${ANTHROPIC_API_KEY:-}" ] && AGENT_SECRETS="${AGENT_SECRETS},ANTHROPIC_API_KEY=haulback-anthropic-key:latest"
[ -n "${OPENAI_API_KEY:-}" ] && AGENT_SECRETS="${AGENT_SECRETS},OPENAI_API_KEY=haulback-openai-key:latest"
[ -n "${GROQ_API_KEY:-}" ] && AGENT_SECRETS="${AGENT_SECRETS},GROQ_API_KEY=haulback-groq-key:latest"

# The stand-in ledger persists one small JSON world snapshot. Keep one
# authoritative writer. The HTTP edge is public so the agent can call it,
# but every /graphql request still requires the bearer LEDGER_TOKEN.
# A production carrier/TMS/ERP integration replaces this service.
echo "Deploying carrier-ledger stand-in..."
gcloud run deploy haulback-ledger \
  --image "$LEDGER_IMG" --region "$REGION" --project "$PROJECT" \
  --allow-unauthenticated --port 8090 \
  --max-instances 1 --concurrency 1 \
  --set-env-vars "WORLD_SEED=${WORLD_SEED}" \
  --set-secrets "$LEDGER_SECRETS"

LEDGER_SERVICE_URL="$(gcloud run services describe haulback-ledger \
  --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
LEDGER_GRAPHQL_URL="${LEDGER_SERVICE_URL%/}/graphql"

echo "Deploying Control Room..."
gcloud run deploy haulback-review \
  --image "$AGENT_IMG" --region "$REGION" --project "$PROJECT" \
  --allow-unauthenticated --port 8080 \
  --set-env-vars "NODE_ENV=production,LEDGER_URL=${LEDGER_GRAPHQL_URL},DASHBOARD_USER=${DASHBOARD_USER},OSS_BASE_URL=${OSS_BASE_URL}" \
  --set-secrets "$AGENT_SECRETS"

echo "Creating/updating sweep job..."
if gcloud run jobs describe haulback-sweep --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud run jobs update haulback-sweep \
    --image "$AGENT_IMG" --region "$REGION" --project "$PROJECT" \
    --set-env-vars "NODE_ENV=production,LEDGER_URL=${LEDGER_GRAPHQL_URL},OSS_BASE_URL=${OSS_BASE_URL}" \
    --set-secrets "$AGENT_SECRETS" \
    --command node --args "dist/src/cli.js,sweep,--advance-days,1,--model,${DRAFT_MODEL}" \
    --max-retries 1 --task-timeout 20m
else
  gcloud run jobs create haulback-sweep \
    --image "$AGENT_IMG" --region "$REGION" --project "$PROJECT" \
    --set-env-vars "NODE_ENV=production,LEDGER_URL=${LEDGER_GRAPHQL_URL},OSS_BASE_URL=${OSS_BASE_URL}" \
    --set-secrets "$AGENT_SECRETS" \
    --command node --args "dist/src/cli.js,sweep,--advance-days,1,--model,${DRAFT_MODEL}" \
    --max-retries 1 --task-timeout 20m
fi

echo "Scheduling one sweep per hour..."
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SCHEDULER_IDENTITY="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
JOB_URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/haulback-sweep:run"
if gcloud scheduler jobs describe haulback-hourly --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http haulback-hourly \
    --location "$REGION" --project "$PROJECT" \
    --schedule "37 * * * *" --uri "$JOB_URI" --http-method POST \
    --oauth-service-account-email "$SCHEDULER_IDENTITY"
else
  gcloud scheduler jobs create http haulback-hourly \
    --location "$REGION" --project "$PROJECT" \
    --schedule "37 * * * *" --uri "$JOB_URI" --http-method POST \
    --oauth-service-account-email "$SCHEDULER_IDENTITY"
fi

echo
echo "Done."
echo "Ledger:      ${LEDGER_SERVICE_URL}"
echo "GraphQL:     ${LEDGER_GRAPHQL_URL}"
echo "ControlRoom: $(gcloud run services describe haulback-review --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
echo "Sweep:       Cloud Run job haulback-sweep, hourly at :37 via Cloud Scheduler haulback-hourly"
echo "First run:   gcloud run jobs execute haulback-sweep --region ${REGION} --project ${PROJECT} --wait"
echo "If Scheduler reports permission denied, grant roles/run.invoker on the job to ${SCHEDULER_IDENTITY} in your project's IAM policy."
