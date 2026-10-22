#!/usr/bin/env bash
# Deploy the Stand-In hosted judge demo to an AWS Lightsail container service
# (spec M6). Idempotent: re-running builds a new image, pushes it and rolls out
# a new deployment to the same service and URL.
#
# Usage:
#   REGION=ap-south-1 \
#   BEDROCK_MODEL_ID=<model or inference-profile id> \
#   RUNTIME_AWS_ACCESS_KEY_ID=<runtime IAM user key id> \
#   RUNTIME_AWS_SECRET_ACCESS_KEY=<runtime IAM user secret> \
#   [SERVICE_NAME=stand-in] [POWER=micro] [SCALE=1] \
#     scripts/deploy-lightsail.sh
#
# The deploy identity is whatever the aws CLI resolves (AWS_PROFILE / SSO).
# The container gets a SEPARATE least-privilege identity (see
# infra/iam-standin-runtime-policy.json) through RUNTIME_AWS_*; those values
# only ever go into the deployment's container environment.
#
# Alexa+ account linking (optional): OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET,
# OAUTH_REDIRECT_URIS, OAUTH_LINK_PASSCODE, OAUTH_SCOPES, OAUTH_CLIENT_CREDENTIALS
# and MCP_PUBLIC_DISCOVERY are read from the shell environment, else from .env.
# PUBLIC_BASE_URL is set to the service URL (override with
# LIGHTSAIL_PUBLIC_BASE_URL, e.g. for a custom domain); it must equal the base
# of the MCP endpoint in the add-on's addon.json.
#
# STANDIN_TOKEN is read from the local .env at deploy time. No secret value is
# ever echoed: the deployment JSON lives in a 0600 temp file that is removed on
# exit, and AWS responses are filtered with --query so they never print it.
#
# DRY_RUN=1 skips every AWS write, the image build and the tool checks, and
# prints the deployment JSON with secret values redacted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

REGION="${REGION:-${1:-}}"
SERVICE_NAME="${SERVICE_NAME:-${2:-stand-in}}"
POWER="${POWER:-${3:-micro}}"
SCALE="${SCALE:-1}"
CONTAINER_NAME="${CONTAINER_NAME:-standin}"
IMAGE_LABEL="${IMAGE_LABEL:-standin}"
LOCAL_IMAGE="${LOCAL_IMAGE:-stand-in:deploy}"
DRY_RUN="${DRY_RUN:-0}"
WAIT_SECONDS="${WAIT_SECONDS:-1200}"

log() { printf 'deploy: %s\n' "$*" >&2; }
die() { printf 'deploy: error: %s\n' "$*" >&2; exit 1; }

# Reads KEY=value from the .env file without sourcing it (no code execution).
# Strips one level of matching surrounding quotes. Prints nothing if unset.
dotenv_get() {
  local key="$1" line value
  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------
[[ -n "$REGION" ]] || die "REGION is required (e.g. REGION=ap-south-1)"
[[ "$SERVICE_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "SERVICE_NAME must be lowercase letters, digits and hyphens"
case "$POWER" in nano | micro | small | medium | large | xlarge) ;; *) die "POWER must be one of nano|micro|small|medium|large|xlarge" ;; esac
[[ "$SCALE" =~ ^[1-9][0-9]?$ ]] || die "SCALE must be 1-20"

# Region the app calls Bedrock and Polly in (defaults to the Lightsail region).
APP_AWS_REGION="${APP_AWS_REGION:-$REGION}"
BEDROCK_MODEL_ID="${BEDROCK_MODEL_ID:-$(dotenv_get BEDROCK_MODEL_ID)}"
[[ -n "$BEDROCK_MODEL_ID" ]] || die "BEDROCK_MODEL_ID is required (env or .env)"
POLLY_VOICE="${POLLY_VOICE:-$(dotenv_get POLLY_VOICE)}"
POLLY_VOICE="${POLLY_VOICE:-Kajal}"
POLLY_VOICE_ALEXA="${POLLY_VOICE_ALEXA:-Joanna}"

# Request-shape limits and spend caps (see apps/mcp-server/src/config.ts).
RATE_LIMIT_RPS="${RATE_LIMIT_RPS:-10}"
RATE_LIMIT_BURST="${RATE_LIMIT_BURST:-40}"
SIM_LLM_RPS="${SIM_LLM_RPS:-1}"
SIM_LLM_BURST="${SIM_LLM_BURST:-12}"
SIM_TTS_RPS="${SIM_TTS_RPS:-2}"
SIM_TTS_BURST="${SIM_TTS_BURST:-20}"
SIM_LLM_HOURLY_CAP="${SIM_LLM_HOURLY_CAP:-200}"
SIM_TTS_HOURLY_CAP="${SIM_TTS_HOURLY_CAP:-800}"
# Daily (per UTC day) spend caps, set explicitly from the dollar ceiling in docs/DEPLOY.md:
# Bedrock calls from the sim host, Polly requests, and Polly characters (Polly bills per character).
SIM_LLM_DAILY_CAP="${SIM_LLM_DAILY_CAP:-300}"
SIM_TTS_DAILY_CAP="${SIM_TTS_DAILY_CAP:-600}"
SIM_TTS_HOURLY_CHAR_CAP="${SIM_TTS_HOURLY_CHAR_CAP:-12000}"
SIM_TTS_DAILY_CHAR_CAP="${SIM_TTS_DAILY_CHAR_CAP:-40000}"
MAX_SESSIONS="${MAX_SESSIONS:-100}"
MAX_SESSIONS_PER_IP="${MAX_SESSIONS_PER_IP:-6}"
STANDIN_DAILY_CALL_CAP="${STANDIN_DAILY_CALL_CAP:-40}"
MAX_CALL_MINUTES="${MAX_CALL_MINUTES:-25}"
# Optional Host-header allowlist (host[:port], comma list). Unset by default:
# the Origin check already covers browsers, and the Lightsail endpoint's Host
# header should be verified with the smoke test before locking it down.
STANDIN_ALLOWED_HOSTS="${STANDIN_ALLOWED_HOSTS:-}"
for n in RATE_LIMIT_RPS RATE_LIMIT_BURST SIM_LLM_RPS SIM_LLM_BURST SIM_TTS_RPS SIM_TTS_BURST SIM_LLM_HOURLY_CAP \
  SIM_TTS_HOURLY_CAP SIM_LLM_DAILY_CAP SIM_TTS_DAILY_CAP SIM_TTS_HOURLY_CHAR_CAP SIM_TTS_DAILY_CHAR_CAP MAX_SESSIONS MAX_SESSIONS_PER_IP STANDIN_DAILY_CALL_CAP MAX_CALL_MINUTES; do
  [[ "${!n}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "$n must be a number"
done

# Secrets: never echoed.
STANDIN_TOKEN_VALUE="$(dotenv_get STANDIN_TOKEN)"
[[ -n "$STANDIN_TOKEN_VALUE" ]] || die "STANDIN_TOKEN is not set in $ENV_FILE"
[[ "${#STANDIN_TOKEN_VALUE}" -ge 24 ]] || die "STANDIN_TOKEN in .env must be at least 24 characters for the hosted demo"
[[ "$STANDIN_TOKEN_VALUE" != change-me* ]] || die "STANDIN_TOKEN in .env is still the .env.example placeholder"

# Alexa+ account linking (all optional; secrets never echoed).
OAUTH_CLIENT_ID="${OAUTH_CLIENT_ID:-$(dotenv_get OAUTH_CLIENT_ID)}"
OAUTH_CLIENT_SECRET_VALUE="${OAUTH_CLIENT_SECRET:-$(dotenv_get OAUTH_CLIENT_SECRET)}"
OAUTH_REDIRECT_URIS="${OAUTH_REDIRECT_URIS:-$(dotenv_get OAUTH_REDIRECT_URIS)}"
OAUTH_LINK_PASSCODE_VALUE="${OAUTH_LINK_PASSCODE:-$(dotenv_get OAUTH_LINK_PASSCODE)}"
OAUTH_SCOPES="${OAUTH_SCOPES:-$(dotenv_get OAUTH_SCOPES)}"
OAUTH_CLIENT_CREDENTIALS="${OAUTH_CLIENT_CREDENTIALS:-$(dotenv_get OAUTH_CLIENT_CREDENTIALS)}"
MCP_PUBLIC_DISCOVERY="${MCP_PUBLIC_DISCOVERY:-$(dotenv_get MCP_PUBLIC_DISCOVERY)}"
STANDIN_CONTACT="${STANDIN_CONTACT:-$(dotenv_get STANDIN_CONTACT)}"
if [[ -n "$OAUTH_CLIENT_ID" ]]; then
  [[ "$OAUTH_CLIENT_ID" =~ ^[[:graph:]]{1,200}$ ]] || die "OAUTH_CLIENT_ID must be 1-200 printable characters without spaces"
  # The hosted server is public: a confidential client and a consent passcode are mandatory
  # (otherwise anyone who knows the client id could approve and redeem their own code).
  [[ -n "$OAUTH_CLIENT_SECRET_VALUE" ]] || die "OAUTH_CLIENT_SECRET is required when OAUTH_CLIENT_ID is set (see alexa-addon/README.md)"
  [[ "${#OAUTH_CLIENT_SECRET_VALUE}" -ge 24 ]] || die "OAUTH_CLIENT_SECRET must be at least 24 characters for the hosted demo"
  [[ -n "$OAUTH_LINK_PASSCODE_VALUE" ]] || die "OAUTH_LINK_PASSCODE is required when OAUTH_CLIENT_ID is set (see alexa-addon/README.md)"
  [[ "${#OAUTH_LINK_PASSCODE_VALUE}" -ge 8 ]] || die "OAUTH_LINK_PASSCODE must be at least 8 characters"
  [[ -n "$OAUTH_REDIRECT_URIS" ]] || log "warning: OAUTH_REDIRECT_URIS is empty; linking fails until Alexa's redirect URIs are added and you redeploy"
  # Alexa+ lists tools at `alexa-ai deploy`, before anyone has linked: default to both discovery paths.
  OAUTH_CLIENT_CREDENTIALS="${OAUTH_CLIENT_CREDENTIALS:-true}"
  MCP_PUBLIC_DISCOVERY="${MCP_PUBLIC_DISCOVERY:-true}"
  if [[ "$OAUTH_CLIENT_CREDENTIALS" != true && "$MCP_PUBLIC_DISCOVERY" != true ]]; then
    log "warning: OAUTH_CLIENT_CREDENTIALS and MCP_PUBLIC_DISCOVERY are both false; Alexa+ cannot list tools before linking"
  fi
else
  [[ -z "$OAUTH_CLIENT_SECRET_VALUE" && -z "$OAUTH_REDIRECT_URIS" ]] || die "OAUTH_CLIENT_SECRET / OAUTH_REDIRECT_URIS are set but OAUTH_CLIENT_ID is not"
fi
for n in OAUTH_CLIENT_CREDENTIALS MCP_PUBLIC_DISCOVERY; do
  [[ -z "${!n}" || "${!n}" =~ ^(true|false)$ ]] || die "$n must be true or false"
done

RUNTIME_AWS_ACCESS_KEY_ID="${RUNTIME_AWS_ACCESS_KEY_ID:-}"
RUNTIME_AWS_SECRET_ACCESS_KEY="${RUNTIME_AWS_SECRET_ACCESS_KEY:-}"
[[ -n "$RUNTIME_AWS_ACCESS_KEY_ID" && -n "$RUNTIME_AWS_SECRET_ACCESS_KEY" ]] ||
  die "export RUNTIME_AWS_ACCESS_KEY_ID and RUNTIME_AWS_SECRET_ACCESS_KEY for the dedicated runtime IAM user (docs/DEPLOY.md)"
[[ "$RUNTIME_AWS_ACCESS_KEY_ID" =~ ^AKIA[A-Z0-9]{12,}$ ]] ||
  die "RUNTIME_AWS_ACCESS_KEY_ID must be a long-term IAM user access key (AKIA...); temporary credentials expire"
if [[ -n "${AWS_ACCESS_KEY_ID:-}" && "${AWS_ACCESS_KEY_ID}" == "$RUNTIME_AWS_ACCESS_KEY_ID" ]]; then
  die "the deploy identity (AWS_ACCESS_KEY_ID) must not be the runtime IAM user; use a separate deploy profile"
fi

# ---------------------------------------------------------------------------
# Tool checks
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is required"
if [[ "$DRY_RUN" != "1" ]]; then
  command -v aws >/dev/null 2>&1 || die "aws CLI v2 is required"
  command -v lightsailctl >/dev/null 2>&1 || die "lightsailctl is required (brew install aws/tap/lightsailctl)"
  command -v docker >/dev/null 2>&1 || die "docker (or podman aliased as docker) is required"
  docker info >/dev/null 2>&1 || die "the container engine is not running (podman machine start, or start Docker Desktop)"
  # lightsailctl talks to the Docker API socket; with Podman point DOCKER_HOST at its socket.
  if docker --version 2>/dev/null | grep -qi podman && [[ -z "${DOCKER_HOST:-}" ]] && command -v podman >/dev/null 2>&1; then
    sock="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -n 1 || true)"
    if [[ -n "$sock" ]]; then
      export DOCKER_HOST="unix://$sock"
      log "using Podman socket for lightsailctl"
    fi
  fi
  deploy_arn="$(aws sts get-caller-identity --query Arn --output text)" || die "the aws CLI has no working deploy credentials"
  runtime_arn="$(env -u AWS_PROFILE -u AWS_SESSION_TOKEN -u AWS_DEFAULT_PROFILE \
    AWS_ACCESS_KEY_ID="$RUNTIME_AWS_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$RUNTIME_AWS_SECRET_ACCESS_KEY" \
    aws sts get-caller-identity --region "$APP_AWS_REGION" --query Arn --output text 2>/dev/null)" ||
    die "the RUNTIME_AWS_* credentials are not valid"
  [[ "$deploy_arn" != "$runtime_arn" ]] || die "the deploy identity and the runtime identity must be different IAM principals"
  [[ "$runtime_arn" == *":user/"* ]] || die "the runtime identity must be an IAM user (got a non-user principal)"
  log "deploy identity: $deploy_arn"
  log "runtime identity: $runtime_arn"
fi

AWSL=(aws lightsail --region "$REGION")

service_field() { "${AWSL[@]}" get-container-services --service-name "$SERVICE_NAME" --query "containerServices[0].$1" --output text; }

wait_service_ready() {
  local deadline=$((SECONDS + WAIT_SECONDS)) state
  while :; do
    state="$(service_field state)"
    case "$state" in
      READY | RUNNING) log "service state: $state"; return 0 ;;
      PENDING | DEPLOYING | UPDATING) ;;
      *) die "service is in state $state" ;;
    esac
    ((SECONDS < deadline)) || die "timed out waiting for the service (state $state)"
    sleep 10
  done
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" != "1" ]]; then
  log "building $LOCAL_IMAGE for linux/amd64"
  docker build --platform linux/amd64 -t "$LOCAL_IMAGE" "$ROOT"
fi

# ---------------------------------------------------------------------------
# Container service
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "1" ]]; then
  SERVICE_URL="https://${SERVICE_NAME}.example.${REGION}.cs.amazonlightsail.com"
else
  if "${AWSL[@]}" get-container-services --service-name "$SERVICE_NAME" --query 'containerServices[0].containerServiceName' --output text >/dev/null 2>&1; then
    log "service $SERVICE_NAME exists"
    wait_service_ready
    current_power="$(service_field power)"
    if [[ "$current_power" != "$POWER" ]]; then
      log "updating power $current_power -> $POWER"
      "${AWSL[@]}" update-container-service --service-name "$SERVICE_NAME" --power "$POWER" --query 'containerService.state' --output text >/dev/null
      sleep 5
      wait_service_ready
    fi
  else
    log "creating service $SERVICE_NAME (power $POWER, scale $SCALE)"
    "${AWSL[@]}" create-container-service --service-name "$SERVICE_NAME" --power "$POWER" --scale "$SCALE" \
      --tags key=project,value=stand-in --query 'containerService.state' --output text >/dev/null
    wait_service_ready
  fi
  SERVICE_URL="$(service_field url)"
  [[ "$SERVICE_URL" == https://* ]] || die "could not read the service URL"
fi
SERVICE_URL="${SERVICE_URL%/}"
PUBLIC_URL="${LIGHTSAIL_PUBLIC_BASE_URL:-$SERVICE_URL}"
PUBLIC_URL="${PUBLIC_URL%/}"
[[ "$PUBLIC_URL" == https://* ]] || die "LIGHTSAIL_PUBLIC_BASE_URL must be an https URL"

# ---------------------------------------------------------------------------
# Push image
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "1" ]]; then
  IMAGE_REF=":${SERVICE_NAME}.${IMAGE_LABEL}.1"
else
  log "pushing image"
  "${AWSL[@]}" push-container-image --service-name "$SERVICE_NAME" --label "$IMAGE_LABEL" --image "$LOCAL_IMAGE" >/dev/null
  IMAGE_REF="$("${AWSL[@]}" get-container-images --service-name "$SERVICE_NAME" --query 'containerImages[0].image' --output text)"
  [[ "$IMAGE_REF" == :"$SERVICE_NAME".* ]] || die "could not resolve the pushed image reference"
  log "image: $IMAGE_REF"
fi

# ---------------------------------------------------------------------------
# Deployment JSON (0600 temp files, removed on exit)
# ---------------------------------------------------------------------------
umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/standin-deploy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
CONTAINERS_JSON="$WORK/containers.json"
ENDPOINT_JSON="$WORK/endpoint.json"

# Values reach node through its environment (never argv, so never in `ps`).
DEPLOY_REDACT="$DRY_RUN" \
  C_NAME="$CONTAINER_NAME" C_IMAGE="$IMAGE_REF" C_URL="$SERVICE_URL" \
  C_APP_REGION="$APP_AWS_REGION" C_MODEL="$BEDROCK_MODEL_ID" C_VOICE="$POLLY_VOICE" C_VOICE_ALEXA="$POLLY_VOICE_ALEXA" \
  C_RATE_LIMIT_RPS="$RATE_LIMIT_RPS" C_RATE_LIMIT_BURST="$RATE_LIMIT_BURST" \
  C_SIM_LLM_RPS="$SIM_LLM_RPS" C_SIM_LLM_BURST="$SIM_LLM_BURST" C_SIM_TTS_RPS="$SIM_TTS_RPS" C_SIM_TTS_BURST="$SIM_TTS_BURST" \
  C_SIM_LLM_HOURLY_CAP="$SIM_LLM_HOURLY_CAP" C_SIM_TTS_HOURLY_CAP="$SIM_TTS_HOURLY_CAP" \
  C_SIM_LLM_DAILY_CAP="$SIM_LLM_DAILY_CAP" C_SIM_TTS_DAILY_CAP="$SIM_TTS_DAILY_CAP" \
  C_SIM_TTS_HOURLY_CHAR_CAP="$SIM_TTS_HOURLY_CHAR_CAP" C_SIM_TTS_DAILY_CHAR_CAP="$SIM_TTS_DAILY_CHAR_CAP" \
  C_MAX_SESSIONS="$MAX_SESSIONS" C_MAX_SESSIONS_PER_IP="$MAX_SESSIONS_PER_IP" \
  C_STANDIN_DAILY_CALL_CAP="$STANDIN_DAILY_CALL_CAP" C_MAX_CALL_MINUTES="$MAX_CALL_MINUTES" \
  C_ALLOWED_HOSTS="$STANDIN_ALLOWED_HOSTS" C_PUBLIC_URL="$PUBLIC_URL" \
  C_OAUTH_CLIENT_ID="$OAUTH_CLIENT_ID" C_OAUTH_REDIRECT_URIS="$OAUTH_REDIRECT_URIS" C_OAUTH_SCOPES="$OAUTH_SCOPES" \
  C_OAUTH_CLIENT_CREDENTIALS="$OAUTH_CLIENT_CREDENTIALS" C_MCP_PUBLIC_DISCOVERY="$MCP_PUBLIC_DISCOVERY" C_CONTACT="$STANDIN_CONTACT" \
  S_TOKEN="$STANDIN_TOKEN_VALUE" S_KEY_ID="$RUNTIME_AWS_ACCESS_KEY_ID" S_SECRET="$RUNTIME_AWS_SECRET_ACCESS_KEY" \
  S_OAUTH_SECRET="$OAUTH_CLIENT_SECRET_VALUE" S_OAUTH_PASSCODE="$OAUTH_LINK_PASSCODE_VALUE" \
  node --input-type=module - "$CONTAINERS_JSON" "$ENDPOINT_JSON" <<'NODE'
import { writeFileSync } from 'node:fs';
const [containersPath, endpointPath] = process.argv.slice(2);
const e = process.env;
const redact = e.DEPLOY_REDACT === '1';
const secret = (v) => (redact ? '<redacted>' : v);
const environment = {
  STANDIN_MODE: 'aws',
  HOST: '0.0.0.0',
  PORT: '8080',
  SQLITE_PATH: '/data/standin.db',
  DEMO_EMBED_TOKEN: 'true',
  TRUST_PROXY: 'true',
  TRUST_PROXY_HOPS: '1',
  STANDIN_ALLOWED_ORIGINS: e.C_URL,
  PUBLIC_BASE_URL: e.C_PUBLIC_URL,
  AWS_REGION: e.C_APP_REGION,
  BEDROCK_MODEL_ID: e.C_MODEL,
  POLLY_VOICE: e.C_VOICE,
  POLLY_VOICE_ALEXA: e.C_VOICE_ALEXA,
  RATE_LIMIT_RPS: e.C_RATE_LIMIT_RPS,
  RATE_LIMIT_BURST: e.C_RATE_LIMIT_BURST,
  SIM_LLM_RPS: e.C_SIM_LLM_RPS,
  SIM_LLM_BURST: e.C_SIM_LLM_BURST,
  SIM_TTS_RPS: e.C_SIM_TTS_RPS,
  SIM_TTS_BURST: e.C_SIM_TTS_BURST,
  SIM_LLM_HOURLY_CAP: e.C_SIM_LLM_HOURLY_CAP,
  SIM_TTS_HOURLY_CAP: e.C_SIM_TTS_HOURLY_CAP,
  SIM_LLM_DAILY_CAP: e.C_SIM_LLM_DAILY_CAP,
  SIM_TTS_DAILY_CAP: e.C_SIM_TTS_DAILY_CAP,
  SIM_TTS_HOURLY_CHAR_CAP: e.C_SIM_TTS_HOURLY_CHAR_CAP,
  SIM_TTS_DAILY_CHAR_CAP: e.C_SIM_TTS_DAILY_CHAR_CAP,
  MAX_SESSIONS: e.C_MAX_SESSIONS,
  MAX_SESSIONS_PER_IP: e.C_MAX_SESSIONS_PER_IP,
  STANDIN_DAILY_CALL_CAP: e.C_STANDIN_DAILY_CALL_CAP,
  MAX_CALL_MINUTES: e.C_MAX_CALL_MINUTES,
  STANDIN_TOKEN: secret(e.S_TOKEN),
  AWS_ACCESS_KEY_ID: secret(e.S_KEY_ID),
  AWS_SECRET_ACCESS_KEY: secret(e.S_SECRET),
};
if ((e.C_ALLOWED_HOSTS ?? '') !== '') environment.STANDIN_ALLOWED_HOSTS = e.C_ALLOWED_HOSTS;
// Alexa+ account linking: only the variables that are set.
const optional = {
  OAUTH_CLIENT_ID: e.C_OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URIS: e.C_OAUTH_REDIRECT_URIS,
  OAUTH_SCOPES: e.C_OAUTH_SCOPES,
  OAUTH_CLIENT_CREDENTIALS: e.C_OAUTH_CLIENT_CREDENTIALS,
  MCP_PUBLIC_DISCOVERY: e.C_MCP_PUBLIC_DISCOVERY,
  STANDIN_CONTACT: e.C_CONTACT,
};
for (const [k, v] of Object.entries(optional)) if ((v ?? '') !== '') environment[k] = v;
if ((e.C_OAUTH_CLIENT_ID ?? '') !== '') {
  if ((e.S_OAUTH_SECRET ?? '') !== '') environment.OAUTH_CLIENT_SECRET = secret(e.S_OAUTH_SECRET);
  if ((e.S_OAUTH_PASSCODE ?? '') !== '') environment.OAUTH_LINK_PASSCODE = secret(e.S_OAUTH_PASSCODE);
}
for (const [k, v] of Object.entries(environment)) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`deployment env ${k} is empty`);
}
const containers = {
  [e.C_NAME]: {
    image: e.C_IMAGE,
    environment,
    ports: { 8080: 'HTTP' },
  },
};
const endpoint = {
  containerName: e.C_NAME,
  containerPort: 8080,
  healthCheck: {
    path: '/health',
    intervalSeconds: 10,
    timeoutSeconds: 5,
    healthyThreshold: 2,
    unhealthyThreshold: 3,
    successCodes: '200',
  },
};
writeFileSync(containersPath, JSON.stringify(containers, null, 2), { mode: 0o600 });
writeFileSync(endpointPath, JSON.stringify(endpoint, null, 2), { mode: 0o600 });
NODE

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN=1: deployment JSON (secrets redacted); nothing was built, pushed or deployed"
  cat "$CONTAINERS_JSON" "$ENDPOINT_JSON"
  printf '\n%s\n' "$SERVICE_URL"
  exit 0
fi

# ---------------------------------------------------------------------------
# Deploy and wait for ACTIVE. Responses contain the container environment, so
# only the version/state fields are ever printed.
# ---------------------------------------------------------------------------
log "creating deployment"
VERSION="$("${AWSL[@]}" create-container-service-deployment --service-name "$SERVICE_NAME" \
  --containers "file://$CONTAINERS_JSON" --public-endpoint "file://$ENDPOINT_JSON" \
  --query 'containerService.nextDeployment.version' --output text)"
[[ "$VERSION" =~ ^[0-9]+$ ]] || die "could not read the new deployment version"
rm -f "$CONTAINERS_JSON" "$ENDPOINT_JSON"
log "deployment version $VERSION"

deadline=$((SECONDS + WAIT_SECONDS))
while :; do
  state="$("${AWSL[@]}" get-container-service-deployments --service-name "$SERVICE_NAME" \
    --query "deployments[?version==\`$VERSION\`].state | [0]" --output text)"
  case "$state" in
    ACTIVE) break ;;
    FAILED) die "deployment $VERSION FAILED; see: aws lightsail get-container-log --region $REGION --service-name $SERVICE_NAME --container-name $CONTAINER_NAME" ;;
    INACTIVE) die "deployment $VERSION became INACTIVE (superseded?)" ;;
  esac
  ((SECONDS < deadline)) || die "timed out waiting for deployment $VERSION (state $state)"
  sleep 15
done

log "deployment $VERSION is ACTIVE"
log "smoke test: scripts/smoke-live.sh $SERVICE_URL"
if [[ -n "$OAUTH_CLIENT_ID" ]]; then
  log "account linking: issuer $PUBLIC_URL; render the add-on with: node scripts/render-addon.mjs --base-url $PUBLIC_URL --verify"
  log "note: the container disk is ephemeral, so a redeploy clears issued tokens and Alexa users must link again"
fi
printf '%s\n' "$SERVICE_URL"
