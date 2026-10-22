# Stand-In: product feedback

Project: **Stand-In**, an Alexa+ add-on (a self-hosted MCP server) that makes customer-care calls for the user.
Hackathon: Build, Ship, Shape: Amazon Developer Hackathon. Tracks entered: **Alexa+**. Mini challenges: **AWS Builder** and **Open Source**.
Repo: `<REPO_URL>` (TODO) · License: MIT · Author: Mahal

This file covers every tool, API and SDK the project uses: what we used it for, what worked, what needs work, how onboarding went, and whether we would build with it again. The step-by-step friction entries are in [`friction-log.md`](./friction-log.md). Feature requests are in [`feature-requests.md`](./feature-requests.md).

## Status

| Part | Status |
| :--- | :--- |
| MCP server (`apps/mcp-server`) | **Real.** Official `@modelcontextprotocol/sdk` 1.32.1, Streamable HTTP, 11 tools, 3 resources, elicitation, an MCP Apps call card, OAuth 2.1 + PKCE account linking. |
| Alexa+ host (`apps/alexa-sim`) | **Simulated.** It runs a real MCP client in the browser and shows a JSON-RPC trace panel. The hackathon rules allow this, and its source is in the repo. |
| Phone network and business | **Simulated.** `SimCarrier` plus a fake business, "BharatNet Broadband", with a scripted human agent. No real calls are placed. Twilio was not built. |
| Disclosure guard and call state machine | **Real.** These are code, with tests. |
| LLM | Amazon Bedrock Converse in `aws` mode (wired, and tested with a mocked client). OpenAI is used only for local evaluation. A deterministic scripted policy runs offline. |
| Real Alexa+ add-on | **Server ready but not connected.** Account linking, the `addon.json` template, assets and privacy/terms pages exist. We could not get access to the Alexa+ MCP Toolkit (see below). |
| Live AWS deployment | **Not deployed yet.** The new AWS account is stuck in verification (see "AWS services used and how"). Live URL: `<LIVE_URL>` (TODO). Judge token: `<JUDGE_TOKEN>` (TODO). |

Quality numbers:

- `pnpm test`: 964 passed, 2 skipped.
- `pnpm eval` (scripted policy): 8/8 required scenarios passed, 0 never-tier leaks, 0 crashes.
- `pnpm eval --llm openai --seeds 5` (gpt-5.4-mini): 40/40 runs, 0 never-tier leaks, 0 crashes.

## AWS services used and how (AWS Builder mini challenge)

All AWS access goes through the AWS SDK for JavaScript v3 with the default credential chain. No keys are in code. Each client can be injected, so tests never touch the network. In `STANDIN_MODE=offline` the same code paths run against local fallbacks, so the demo works with no AWS account.

| Service | How Stand-In uses it | Where | State |
| :--- | :--- | :--- | :--- |
| **Amazon Bedrock (Converse API)** | Two roles. (1) The call planner proposes the next thing to say or the next menu choice inside the current call state. Its JSON output is checked with zod, and bad output gets a safe fallback reply. (2) The simulated Alexa+ orchestrator uses Converse tool use to choose MCP tool calls. We used inference profile `us.anthropic.claude-haiku-5-5` in us-east-1. One global hourly and daily call budget is shared by the orchestrator and the planner. When the budget runs out, both fall back to the scripted policy. `never`-tier values (OTP, PIN, CVV, card, Aadhaar, passwords) are withheld before any prompt is built. | `packages/providers/src/llm/bedrock.ts`, `apps/mcp-server/src/config.ts` | Wired and unit-tested with a mocked client. Live calls are blocked by account verification. |
| **Amazon Polly (neural)** | Speech for the demo. Stand-In speaks with `Kajal` (en-IN), and the IVR and the agent use separate voices (defaults `Amy` and `Brian`, en-GB); the simulated Alexa+ voice defaults to `Joanna` (en-US). Text reaches Polly only after the disclosure guard has checked it. Usage is capped by requests and by characters per hour and per UTC day. Defaults are 15,000 characters per hour and 50,000 per day. When the cap is reached, the server returns 204 and the browser voice takes over. | `packages/providers/src/tts/polly.ts`, `apps/mcp-server/src/config.ts` | Wired and tested with a mocked client. Not run live. |
| **Amazon Lightsail container service** | The planned host: a single-container deployment. There is an idempotent deploy script (create or update the service, push the image with `lightsailctl`, deploy, wait for the result), a multi-stage `linux/amd64` Dockerfile on `node:22-bookworm-slim` that smoke-tests `better-sqlite3` at build time, and a live smoke test. | `scripts/deploy-lightsail.sh`, `Dockerfile`, `scripts/smoke-live.sh`, `docs/DEPLOY.md` | Written. No live deployment yet (blocked). |
| **AWS IAM** | A separate least-privilege runtime identity for the container. It only allows `bedrock:InvokeModel` on one inference profile and its foundation model, plus `polly:SynthesizeSpeech` restricted to one region. The deploy identity is never passed to the container. | `infra/iam-standin-runtime-policy.json`, `docs/DEPLOY.md` | Template written. |
| **Amazon EventBridge Scheduler** | An optional adapter for follow-up calls ("call back if the promise is broken"). It creates one-time `at(...)` schedules that are deleted after they fire. The schedule input carries only ids, never case facts. The default everywhere is a local SQLite ticker. | `packages/providers/src/scheduler/eventbridge.ts` | Adapter implemented and tested with a mocked client. Off by default (`SCHEDULER=eventbridge` opts in). The schedule target (e.g. a Lambda that calls back into the server) is not included; the local SQLite ticker is what runs follow-ups. |
| **Amazon DynamoDB** | `DynamoRepo` is a stub. It compiles against the `Repo` interface, but every method throws `NotImplementedError`. SQLite is the only storage that works. | `packages/providers/src/repo/index.ts` | **Not implemented.** |

### Why the live AWS run is blocked

The AWS account was created for this hackathon and is still in verification. Every attempt to add a payment card fails with `Error 880104: Sorry, there was an error processing your request`. Until the account is verified, Bedrock Converse returns `AccessDeniedException` ("Your account is currently being verified"). As a result:

- Bedrock and Polly are verified only with mocked SDK clients. The live LLM path we did verify end to end is the OpenAI path, which is used for evaluation only.
- The Lightsail deployment has not run. `<LIVE_URL>` and `<JUDGE_TOKEN>` are TODO placeholders.
- A support case is the workaround in progress. Friction-log entry 5 has the details.

---

## Amazon tools

### Alexa+ MCP Toolkit (docs, Alexa AI CLI) and the Alexa developer console

- **What we used it for:** the add-on contract. This includes Streamable HTTP, a 401 without `WWW-Authenticate` to start account linking, OAuth discovery metadata, the `addon.json` manifest and assets, and the account-linking flow.
- **What worked well:**
  - The QuickStart's auth rules are concrete. We could implement them exactly: unauthenticated `/mcp` returns 401 with no `WWW-Authenticate` header, plus RFC 9728 protected-resource and RFC 8414 authorization-server metadata.
  - Building on standard MCP means the server works with any MCP client. Our browser simulator uses the same SDK client.
- **What needs work:**
  - **Access.** The Alexa AI CLI is distributed only from a private CodeArtifact registry, reached by cross-account `AssumeRole` into an Amazon-owned role. There is no self-serve sign-up. Our `AssumeRole` on `AddOn3PDeveloperToolsRead` returned `AccessDenied` with no guidance. The toolkit is preview-only and US-only, and the developer console shows no add-on section. We could not connect a real Alexa+ device.
  - **Client behaviour differs from the docs.** The docs target MCP spec 2025-11-25. The Alexa+ client is documented to send `protocolVersion` 2025-03-26 and to keep no MCP session id per add-on. A standard stateful SDK server then rejects every call after `initialize` with 400 "No valid session ID". We added a stateless fallback: a non-initialize request with no session id is served by a one-shot server and transport.
  - **Account linking.** The Alexa redirect URIs appear only after you run `configure-account-linking`, so you cannot allowlist them in advance. The `--config-file` JSON schema is undocumented. The client auth method (basic, post or public) is not specified. The Tier-1 `client_credentials` discovery requirement is unclear for public servers. We support all three auth methods and an optional `client_credentials` grant limited to discovery.
- **Onboarding:** blocked at the access step. Everything after that was built from the docs alone.
- **Build with it again:** yes, once access is self-serve. An MCP add-on is the right shape for this product.

### Amazon Bedrock (Converse API)

- **What we used it for:** the call planner (JSON output) and the simulated host's tool-use loop. See the table above.
- **What worked well:**
  - One message format across model providers. We could keep a provider-neutral `LlmProvider` interface and swap models with an environment variable.
  - Tool use in Converse mapped cleanly onto MCP `tools/list` schemas.
  - Inference profile IDs let us keep the same code across regions.
- **What needs work:**
  - Converse requires the system prompt to be sent separately, and turns must alternate user/assistant starting with user. We had to merge consecutive same-role turns and add a lead-in user turn. A clearer error, or optional automatic normalization, would save time.
  - The IAM action that authorizes Converse is `bedrock:InvokeModel`, and inference profiles need statements for both the profile and the foundation model behind it (with a condition). This is easy to get wrong. A policy generator or a copy-paste example on the Converse page would help.
  - `AccessDeniedException` is used both for "model not enabled" and "account being verified". A distinct error code would make it clear which one to fix.
- **Onboarding:** the SDK and docs were quick to use. Account verification blocked live access.
- **Build with it again:** yes.

### Amazon Polly

- **What we used it for:** neural voices for Stand-In (en-IN Kajal), the IVR and the agent.
- **What worked well:**
  - The SDK exports `VoiceId` and `LanguageCode` enums, so we validate the voice config with zod at startup instead of finding typos at runtime.
  - Per-request voice and language make it easy to give three speakers distinct voices.
- **What needs work:** billing is per character, but there is no built-in per-caller or per-day character budget. We had to build hourly and daily character caps ourselves to make a public demo token safe.
- **Onboarding:** smooth. One command and one IAM action.
- **Build with it again:** yes.

### Amazon Lightsail (container services)

- **What we used it for:** the planned single-container host, with a scripted deploy.
- **What worked well:** a predictable price, a managed HTTPS endpoint, and a small CLI surface (`create-container-service`, `push-container-image`, `create-container-service-deployment`). This fits a single-process MCP server with SQLite.
- **What needs work:**
  - Containers have no instance role. The runtime needs a dedicated IAM user with long-lived access keys passed as environment variables. A role-based option would remove that secret.
  - Pushing images needs a separate plugin (`lightsailctl`) that talks to the Docker socket. With Podman you must point `DOCKER_HOST` at the Podman socket, which is not documented.
- **Onboarding:** the docs are clear. We have not done a live deployment yet because of account verification.
- **Build with it again:** yes, for small single-container services.

### Amazon EventBridge Scheduler

- **What we used it for:** an optional backend for one-time follow-up calls.
- **What worked well:** `at(...)` one-time schedules with automatic deletion after they fire fit "call back on the promised date" exactly. No cleanup job is needed.
- **What needs work:**
  - The `at()` expression expects a timestamp with no timezone suffix, and the timezone is set in a separate field. That is easy to get wrong when coming from ISO-8601.
  - Every target needs an execution role. A "call this HTTPS endpoint" target with no Lambda would suit single-container apps. The closest option today is API destinations through EventBridge.
- **Onboarding:** quick with the SDK. Not run live.
- **Build with it again:** yes, for any app that already has a Lambda or queue target.

### AWS SDK for JavaScript v3

- **What we used it for:** `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-polly` and `@aws-sdk/client-scheduler` (all 3.1149.0).
- **What worked well:**
  - Modular per-service packages, ESM and good TypeScript types.
  - `client.send(command)` is easy to describe with a minimal interface. That let us inject fakes and test every AWS path offline.
  - Exported enums (Polly `VoiceId`) can feed runtime validation directly.
- **What needs work:** streaming output (Polly's `AudioStream`) needs `transformToByteArray()`, which is easy to miss in the docs. Some Bedrock content-block types are wide unions, which makes narrowing verbose.
- **Build with it again:** yes.

### AWS CLI and IAM

- **What we used it for:** the Lightsail deploy script, `sts get-caller-identity` checks, creating the runtime IAM user, and the attempt to `AssumeRole` into the Alexa toolkit registry.
- **What worked well:** `--query` / `--output text` make shell scripts reliable. IAM condition keys (`bedrock:InferenceProfileArn`, `aws:RequestedRegion`) let us write a tight runtime policy.
- **What needs work:** an `AccessDenied` from a cross-account `AssumeRole` does not say whether the role is missing, the trust policy excludes you, or you need to be allowlisted. A hint pointing to the owning program would have saved hours.
- **Build with it again:** yes.

### AWS account activation (billing console)

- **What happened:** adding a payment card failed with `Error 880104` on every attempt, so the account stayed in verification. That blocked Bedrock and the deployment.
- **What needs work:** the error does not say what to do (for example: card type not accepted, region mismatch, or contact support). A self-serve status page for "why is my account still being verified" would help new builders, especially at hackathons. Friction-log entry 5 has the details.

---

## MCP and open-source tools

### @modelcontextprotocol/sdk 1.32.1 (TypeScript)

- **What we used it for:** the server (`McpServer.registerTool`, `registerResource`, `ResourceTemplate`, `Server.elicitInput`, `sendResourceUpdated`, `StreamableHTTPServerTransport`) and the browser client in the simulator.
- **What worked well:**
  - zod-based tool schemas, with `structuredContent` and output schemas.
  - Elicitation was simple to add. We use it to ask for the account number in the middle of a tool call.
  - The same SDK on both sides let us test full JSON-RPC round trips in-process.
- **What needs work:**
  - The stateful Streamable HTTP transport assumes clients keep `Mcp-Session-Id`. Clients that don't, such as the Alexa+ client, get a 400 until you build a stateless fallback by hand. A built-in "stateful if possible, stateless otherwise" mode would help.
  - The v1 → v2 package split (`@modelcontextprotocol/server`) is confusing when extensions target v2 only.
- **Build with it again:** yes.

### @modelcontextprotocol/ext-apps 2.0.3 (MCP Apps), used as a spec reference

- **What we used it for:** the conventions for the `ui://standin/call-card` resource: `_meta.ui.resourceUri` plus the legacy `_meta["ui/resourceUri"]`, MIME type `text/html;profile=mcp-app`, and the postMessage method names (`ui/initialize`, `ui/notifications/tool-result`, and so on).
- **What worked well:** the spec types are clear, and one card that updates in place is the right UX for a long-running call.
- **What needs work:** the server helpers target the newer `@modelcontextprotocol/server` package, not SDK 1.x. The AppBridge-rendered card did not appear in our host. We wrote a small postMessage bridge that follows the ext-apps message types. It sits in a sandboxed iframe that allows scripts only and passes only the call-control tools through. ext-apps is therefore not a runtime dependency. A compatibility note or a 1.x adapter would help.
- **Build with it again:** yes, once the helpers work with the SDK version most servers use.

### zod 4

Used at every boundary: tool inputs and outputs, environment config, LLM output, SDK responses. `z.enum()` over SDK enums was especially useful. Some v3 → v4 API changes (`.loose()`, `z.input` vs `z.infer` with defaults) needed care. We would use it again.

### Vitest 5

It runs 59 test files (58 passed, 1 skipped; 964 tests passed, 2 skipped) in about 16.5 seconds across the workspace from one root config. `happy-dom` covers the React simulator. We would use it again.

### Vite 8 + React 19

These build the simulated Alexa+ host. Fast dev server, simple build. The browser Web Speech APIs give the offline voice fallback. We would use them again.

### better-sqlite3 13

It handles local storage for cases, the hash-chained event log, OAuth state and follow-up jobs. It is synchronous and fast. The native module must match the container's platform and architecture, so the Dockerfile builds for `linux/amd64` and checks the module at build time. We would use it again.

### pnpm 12 workspaces

Workspace packages (`@standin/core`, `disclosure-guard`, `providers`, apps, eval) with `workspace:*` links and filtered builds. Nothing to report. We would use it again.

### TypeScript 6, ESLint, tsx

Strict ESM TypeScript with no `any`. `tsx` runs the eval and the verify CLI without a build step. No issues.

### OpenAI API (evaluation and local development only)

- **What we used it for:** a live LLM for `pnpm eval --llm openai` (gpt-5.4-mini) while Bedrock was unavailable. It is never selected in `aws` mode.
- **What we learned:** the first live run scored 23/40. The planner prompt did not make clear that `speakable=true` means the user has already approved sharing that fact. After we clarified the prompt, the score went to 39/40 and then 40/40, with 0 never-tier leaks in every run. The disclosure guard is code, so prompt quality changed task success but never safety.
- **Build with it again:** yes, as an evaluation baseline next to Bedrock.

---

## Verified claims and how

| Claim | How it was checked |
| :--- | :--- |
| 964 passed, 2 skipped; 59 test files; about 16.5 s | Re-ran `pnpm test` on 2026-10-22: "Test Files 58 passed \| 1 skipped (59)", "Tests 964 passed \| 2 skipped (966)", Duration about 16.2–16.5 s. |
| Scripted eval 8/8, 0 leaks, 0 crashes | Re-ran `pnpm eval`: S1–S8 PASS, "never-tier leaks 0 · crashes 0". |
| OpenAI eval 40/40 (and 23/40, then 39/40) | Final run log committed at `eval/results/openai-gpt-5.4-mini-seeds5.txt` (40/40); the 23/40 and 39/40 runs were earlier development runs, not kept. |
| SDK 1.32.1; AWS SDK 3.1149.0; zod 4.6.7; vitest 5.0.5; vite 8.3.5; react 19.3.1; better-sqlite3 13.0.3; pnpm 12.6.0 | Read from every `package.json` in the workspace. |
| ext-apps is not a runtime dependency; conventions follow 2.0.3; v2-only helpers | Not in any `package.json`. Header comments in `apps/mcp-server/src/mcp.ts`, `card.ts` and `apps/alexa-sim/src/lib/card-bridge.ts`. |
| 11 tools, 3 resources, elicitation | 11 `registerTool` and 3 `registerResource` calls plus `elicitInput` in `apps/mcp-server/src/mcp.ts`. |
| 401 without `WWW-Authenticate`; stateless fallback; PKCE S256; auth methods; optional `client_credentials` | `apps/mcp-server/src/http.ts` (around lines 386, 475–493) and `apps/mcp-server/src/oauth.ts` (lines 350, 555, 624–625). |
| Bedrock Converse with tool use, injectable client | `packages/providers/src/llm/bedrock.ts`. |
| Polly voices Kajal / Amy / Brian; character caps 15,000/hour and 50,000/day; LLM caps | `packages/providers/src/tts/polly.ts`; `apps/mcp-server/src/config.ts`. |
| EventBridge one-time schedules with ids-only input; off by default | Header of `packages/providers/src/scheduler/eventbridge.ts`. |
| DynamoRepo is a stub | `packages/providers/src/repo/index.ts`: every method throws `NotImplementedError`. |
| Lightsail script, `lightsailctl`, Podman note, `linux/amd64`, `node:22-bookworm-slim`, build-time sqlite check | `scripts/deploy-lightsail.sh`; `Dockerfile` (lines 12, 20, 64, 70). |
| Lightsail has no instance role, so a runtime IAM user is needed; IAM policy contents | `docs/DEPLOY.md` step 6; `infra/iam-standin-runtime-policy.json`. |
| OpenAI is eval and local dev only, never in `aws` mode | Header of `packages/providers/src/llm/openai.ts`. |
| MIT license, author Mahal | `LICENSE`. |
| Inference profile `us.anthropic.claude-haiku-5-5` (us-east-1), Error 880104, Bedrock `AccessDeniedException`, Alexa toolkit `AccessDenied`, browser autoplay checks | Session facts (configured through `.env`, which was not read). |
| Converse turn-normalization requirement | `toConverseInput()` in `bedrock.ts` merges same-role turns and adds a lead-in user turn. |
| EventBridge `at()` timezone and HTTPS-target remarks, SDK `AudioStream` remark | General product knowledge, not tested live in this project. |
