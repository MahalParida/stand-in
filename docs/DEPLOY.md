# Deploying the hosted judge demo (AWS Lightsail)

The hosted demo runs as one container on an **AWS Lightsail container service**:
`apps/mcp-server` serves `/mcp`, `/sim/api/*`, `/health`, `/.well-known/*` and the
built `apps/alexa-sim` page. It uses `STANDIN_MODE=aws` (Bedrock Converse + Polly),
`SimCarrier`, and SQLite on the container's local disk.

- **Must stay up until Nov 20, 2026** (judging). Tear it down after that (see the end of this page).
- SQLite lives at `/data/standin.db` inside the container. It **resets on every redeploy**.
  Restart recovery already marks calls that were running when the process stopped as `FAILED (server_restart)`.
- `DEMO_EMBED_TOKEN=true`: the sim page fetches the Bearer token from `/sim/config`, so the
  token is effectively public. Cost is bounded by rate limits and hourly/daily caps, not by the token.

Files involved:

| File | Purpose |
| :--- | :--- |
| `Dockerfile`, `.dockerignore` | Multi-stage linux/amd64 image, non-root, `/health` healthcheck |
| `scripts/deploy-lightsail.sh` | Build, push, deploy, wait for `ACTIVE`, print the URL |
| `scripts/smoke-live.sh` (+ `scripts/smoke-mcp.mjs`) | Checks a live URL |
| `infra/iam-standin-runtime-policy.json` | Least-privilege policy for the container's own IAM user |

## 1. Prerequisites

1. **Container engine**, running:
   - Podman: `podman machine start` (the local `docker` command is Podman). On Apple Silicon the
     amd64 build runs under emulation and is slower. `lightsailctl` talks to the Docker API socket;
     the deploy script points `DOCKER_HOST` at the Podman machine socket automatically. To do it by hand:
     `export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"`.
   - or Docker Desktop, started.
2. **AWS CLI v2** (`aws --version`) and the Lightsail push plugin: `brew install aws/tap/lightsailctl`.
3. **A deploy identity** for the CLI (your normal `AWS_PROFILE` / SSO). It needs Lightsail
   container permissions and `sts:GetCallerIdentity`. It is *not* passed to the container.
4. **Region.** Pick one Lightsail region that offers container services (for example `ap-south-1`).
   Bedrock and Polly use the same region by default. Set `APP_AWS_REGION` to use a different region for them.
5. **Bedrock model access** in that region for the model you set as `BEDROCK_MODEL_ID`. Open the
   Bedrock console, go to *Model access*, and enable the model. Some providers ask for a use-case form.
   In regions where the model is only offered through a cross-region **inference profile** (for example
   `apac.<provider>.<model>`), use the profile ID as `BEDROCK_MODEL_ID`. The Polly voice (`POLLY_VOICE`,
   default `Kajal`, a neural voice) must be available in that region.
6. **A dedicated runtime IAM user** for the container (Lightsail containers have no instance role).
   It is separate from the deploy identity and has only `infra/iam-standin-runtime-policy.json`:

   ```bash
   REGION=ap-south-1
   ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   PROFILE_ID=apac.amazon.nova-lite-v1:0     # inference profile you use (or delete statements 1-2)
   MODEL_ID=amazon.nova-lite-v1:0            # foundation model behind it / used directly

   sed -e "s/ACCOUNT_ID/$ACCOUNT_ID/g" -e "s/INFERENCE_PROFILE_ID/$PROFILE_ID/g" \
       -e "s/FOUNDATION_MODEL_ID/$MODEL_ID/g" -e "s/REGION/$REGION/g" \
       infra/iam-standin-runtime-policy.json > /tmp/standin-runtime-policy.json

   aws iam create-user --user-name standin-runtime --tags Key=project,Value=stand-in
   aws iam put-user-policy --user-name standin-runtime --policy-name standin-runtime \
       --policy-document file:///tmp/standin-runtime-policy.json
   aws iam create-access-key --user-name standin-runtime   # store the pair in a password manager
   ```

   The policy allows only `bedrock:InvokeModel` (this is the IAM action that authorizes the
   Converse API; streaming is not used) on the configured inference-profile / foundation-model ARNs,
   and `polly:SynthesizeSpeech` in the chosen region. If you call a foundation model directly, delete
   the two inference-profile statements; if you only use a profile, delete the third statement.
   Never put these keys in the image, the repo, `.env`, or a shell history file.
7. **An AWS Budgets alert** before the first deploy, for example a monthly cost budget of $25 with
   email alerts at 50% / 80% / 100% (Billing console, *Budgets*, *Create budget*, *Customize*, *Cost budget*).
   Optionally add a Budgets action or a CloudWatch alarm that notifies you on Bedrock spend.
8. **`STANDIN_TOKEN` in the local `.env`**, at least 24 characters and not the `.env.example`
   placeholder. Generate one with `openssl rand -base64 36 | tr -d '/+='`.

## 2. Deploy

```bash
# deploy identity (Lightsail permissions), never the runtime user
export AWS_PROFILE=<your-deploy-profile>

# runtime IAM user keys for the container: read them without echoing
read -rs RUNTIME_AWS_ACCESS_KEY_ID && export RUNTIME_AWS_ACCESS_KEY_ID
read -rs RUNTIME_AWS_SECRET_ACCESS_KEY && export RUNTIME_AWS_SECRET_ACCESS_KEY

REGION=ap-south-1 \
BEDROCK_MODEL_ID=apac.amazon.nova-lite-v1:0 \
SERVICE_NAME=stand-in POWER=micro \
  scripts/deploy-lightsail.sh
```

What the script does (it is idempotent; re-running it rolls out a new deployment to the same URL):

1. Checks `aws`, `lightsailctl`, a running `docker`/Podman, that the deploy and runtime identities
   are different IAM principals, and that the runtime identity is an IAM user with long-term keys.
2. `docker build --platform linux/amd64 -t stand-in:deploy .`
3. Creates the container service if it is missing (power `POWER`, scale `SCALE`, default 1) and waits for `READY`.
   If it exists with a different power, it updates the power.
4. `aws lightsail push-container-image` and resolves the pushed image reference.
5. Writes the deployment JSON to a `0600` temp file (removed on exit). The container environment is
   `STANDIN_MODE=aws`, `HOST=0.0.0.0`, `PORT=8080`, `SQLITE_PATH=/data/standin.db`, `DEMO_EMBED_TOKEN=true`,
   `TRUST_PROXY=true`, `STANDIN_ALLOWED_ORIGINS=<service URL>`, `PUBLIC_BASE_URL=<service URL>`, `AWS_REGION`,
   `BEDROCK_MODEL_ID`, `POLLY_VOICE`, `POLLY_VOICE_ALEXA`, the caps below, `STANDIN_TOKEN` (read from `.env`), and
   the runtime user's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. The public endpoint is port 8080 with health check path `/health`.
6. `create-container-service-deployment`, waits for the deployment to be `ACTIVE`, prints the URL.

No secret value is printed. AWS responses are filtered with `--query`, because they echo the container environment.

`DRY_RUN=1` prints the deployment JSON with secrets redacted and changes nothing in AWS.

### Caps (override by exporting them before running the script)

| Variable | Deploy default | Effect |
| :--- | :--- | :--- |
| `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` | 10 / 40 | per-IP token bucket for `/mcp` and `/sim/api` |
| `SIM_LLM_RPS` / `SIM_LLM_BURST` | 1 / 12 | per-IP bucket for `/sim/api/llm` (Bedrock) |
| `SIM_TTS_RPS` / `SIM_TTS_BURST` | 2 / 20 | per-IP bucket for `/sim/api/tts` (Polly) |
| `SIM_LLM_HOURLY_CAP` | 200 | global Bedrock calls per hour from the sim host; above it, scripted answers |
| `SIM_TTS_HOURLY_CAP` | 800 | global Polly requests per hour; above it, browser speech |
| `SIM_LLM_DAILY_CAP` | 300 | global Bedrock calls per UTC day from the sim host; above it, scripted answers until 00:00 UTC |
| `SIM_TTS_DAILY_CAP` | 600 | global Polly requests per UTC day; above it, browser speech |
| `SIM_TTS_HOURLY_CHAR_CAP` / `SIM_TTS_DAILY_CHAR_CAP` | 12,000 / 40,000 | global Polly characters per hour / per UTC day (Polly bills per character); above it, browser speech |
| `MAX_SESSIONS` / `MAX_SESSIONS_PER_IP` | 100 / 6 | concurrent MCP sessions |
| `STANDIN_DAILY_CALL_CAP` | 40 | simulated calls per business per day (each call uses Bedrock turns) |
| `MAX_CALL_MINUTES` | 25 | max simulated call length |
| `STANDIN_ALLOWED_HOSTS` | unset | optional Host-header allowlist; set it to the service host only after the smoke test passes |

### Verify

```bash
scripts/smoke-live.sh https://stand-in.<id>.<region>.cs.amazonlightsail.com
```

It checks `/health` 200; `POST /mcp` without a token gives 401 with no `WWW-Authenticate`; a foreign
`Origin` gives 403; `/sim/config` reports `mode: aws`; an authenticated MCP `initialize` + `tools/list`
through the SDK client (run `pnpm install` first). The token comes from `$STANDIN_TOKEN`, else `.env`,
else the demo's `/sim/config`; it is never printed.

Logs: `aws lightsail get-container-log --region $REGION --service-name stand-in --container-name standin`.

## 3. Cost

- **Lightsail Micro power: about $10/month** per node (approximate; check current Lightsail container
  pricing for your region before deploying). Scale 1. Running from now to Nov 20, 2026 is about one month.
- Bedrock and Polly are billed per use on top. The daily caps above bound the worst case even when the public
  demo token is abused:
  - **Polly:** at most 40,000 characters a day. Each request is limited to 600 characters and metered by length.
    At neural list prices (about $16 per 1M characters) that is about **$0.64/day**.
  - **Bedrock (sim host):** at most 300 calls a day. Each call is limited to 40 messages / 64k characters of history,
    24k characters of tool specs (each tool's input schema at most 4 KB) and 512 output tokens: roughly
    22k input tokens per call. With `apac.amazon.nova-lite-v1:0` that is about **$0.50/day**.
  - The simulated phone calls themselves also use Bedrock turns, bounded by `STANDIN_DAILY_CALL_CAP` and `MAX_CALL_MINUTES`.

  Together the sim caps come to about $1.15/day, about $35 for the month to Nov 20, 2026, plus Lightsail. Prices vary
  by region and model, so recompute with your region's prices, and with a larger model lower `SIM_LLM_DAILY_CAP`. The
  caps are in-memory per process: a restart or redeploy starts a fresh day count. The Budgets alert only notifies you;
  it does not stop spending, so set it at or below the total you accept.
- Lightsail's data transfer allowance covers the demo's traffic.

## 4. Rotate `STANDIN_TOKEN`

1. Generate a new value and replace `STANDIN_TOKEN` in the local `.env`.
2. Re-run `scripts/deploy-lightsail.sh` with the same `REGION` / `SERVICE_NAME`. This creates a new deployment
   at the same URL. The SQLite state resets.
3. Run `scripts/smoke-live.sh <URL>`.
4. Update every place the old token was given out (README, Devpost text). Judges with the old token get 401.

Rotate the runtime IAM keys the same way: `aws iam create-access-key --user-name standin-runtime`, redeploy
with the new `RUNTIME_AWS_*`, then `aws iam delete-access-key --user-name standin-runtime --access-key-id <old id>`.

## 5. Tear down (after Nov 20, 2026)

```bash
aws lightsail delete-container-service --region $REGION --service-name stand-in   # deletes images and deployments too
aws iam list-access-keys --user-name standin-runtime
aws iam delete-access-key --user-name standin-runtime --access-key-id <id>
aws iam delete-user-policy --user-name standin-runtime --policy-name standin-runtime
aws iam delete-user --user-name standin-runtime
docker image rm stand-in:deploy
```

Then delete the Budgets alert if nothing else uses it, and remove the live URL and token from the README.

## Notes

- The image was statically checked (paths, lint review), and its build and runtime layout were simulated
  without a container engine. Run `docker build --platform linux/amd64 -t stand-in:deploy .` once locally before the
  first deploy.
- Podman builds OCI images by default and ignores the Dockerfile `HEALTHCHECK`. That is fine: Lightsail uses
  its own health check on `/health`.
- Anyone in the AWS account who can read the Lightsail deployment (console or `get-container-service-deployments`)
  can see its environment, including the runtime keys. Keep the runtime user's policy minimal and rotate keys if
  the account is shared.
