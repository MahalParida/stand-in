# Stand-In: friction log

Project: Stand-In, an Alexa+ add-on (self-hosted MCP server). Track: Alexa+. Mini challenges: AWS Builder, Open Source.
Repository: <REPO_URL> (TODO: fill in before submission).

This log covers friction with Amazon tools and documentation, plus one item with an MCP ecosystem package that the
Alexa+ MCP Toolkit relies on (entry 4). Each entry lists what we tried, what happened, the workaround we shipped, and one
concrete suggestion. Error strings are quoted as they appeared. Where we did not keep the exact text, we say so
instead of reconstructing it.

## Summary

| # | Area | Severity | Status |
| :- | :--- | :--- | :--- |
| 1 | Alexa+ MCP Toolkit access (Alexa AI CLI) | Blocker | Not resolved. Real Alexa+ add-on not connected; simulated Alexa+ host used instead. |
| 2 | Alexa+ client session behaviour vs. MCP spec 2025-11-25 | Major | Worked around (stateless fallback in the server). |
| 3 | Account linking documentation gaps | Major | Worked around (configurable server settings, documented open questions). |
| 4 | `@modelcontextprotocol/ext-apps` 2.x helpers vs. SDK 1.x | Minor | Worked around (hand-written postMessage bridge). |
| 5 | New AWS account activation (payment card Error 880104) | Blocker | Not resolved. Bedrock and the live deploy are blocked; support case route. |

---

## 1. Alexa+ MCP Toolkit access: no self-serve path, AccessDenied with no guidance

**Task.** Install the Alexa AI CLI (`alexa-ai`) so we could register Stand-In as a real Alexa+ add-on, run
`alexa-ai configure-account-linking` and `alexa-ai deploy`, and test in the Alexa+ web simulator.

**Steps taken.**
1. Followed "Set Up Your Development Environment" in the Alexa+ add-on docs
   (`https://developer.amazon.com/docs/alexaplus/add-ons/`).
2. Found that the CLI is distributed only from a private AWS CodeArtifact registry. Access requires a cross-account
   STS AssumeRole from our own AWS account into Amazon's account, using the role `AddOn3PDeveloperToolsRead`.
3. Ran the AssumeRole from our AWS account.
4. Looked in the Amazon developer console for an add-on section or a sign-up/allowlist form.

**Expected.** Either a self-serve way to get the CLI, or an error that says "your account is not on the preview
allowlist; request access here".

**Actual.**
- AssumeRole returned `AccessDenied`. The response did not say why, and the docs do not explain how an account gets
  allowlisted.
- There is no self-serve sign-up for the preview.
- The developer console showed no add-on section for our account.
- The toolkit is preview and US-only, and we are building from India.

**Severity.** Blocker for connecting the real Alexa+. Not a blocker for the project, because the hackathon allows a
simulated Alexa+ host.

**Workaround.** We built the server to the published add-on spec anyway: OAuth 2.1 + PKCE account linking, 401 without
`WWW-Authenticate` on `/mcp`, RFC 9728 and RFC 8414 metadata, an `addon.json` manifest template
(`alexa-addon/addon-package/addon.json`), listing assets, `/privacy` and `/terms`, plus a step-by-step connection guide
(`alexa-addon/README.md`). For the demo we use `apps/alexa-sim`, a simulated Alexa+ host that is a real MCP client
running in the browser, with a JSON-RPC trace panel.

**Suggestion.** When AssumeRole into the CodeArtifact role fails, document the reason and the next step on the setup
page: "this role is allowlisted per AWS account; request access at <form>; expected turnaround N days". For a
hackathon that names Alexa+ as a track, pre-allowlist registered participants, or publish the CLI on a public
registry with server-side gating at `alexa-ai deploy`.

---

## 2. Alexa+ client session behaviour does not match a standard stateful MCP server

**Task.** Serve Alexa+ from the official `@modelcontextprotocol/sdk` (1.32.1) Streamable HTTP server, using the
SDK's normal stateful mode (session id issued at `initialize`).

**Steps taken.**
1. Built `/mcp` with `StreamableHTTPServerTransport` and `sessionIdGenerator: () => randomUUID()`.
2. Read the Alexa+ MCP docs. They state MCP spec 2025-11-25. They also document that the Alexa+ client sends
   `protocolVersion` `2025-03-26` and keeps no MCP session id per add-on.
3. Replayed that pattern: a non-initialize request (for example `tools/list` or `tools/call`) with no
   `Mcp-Session-Id` header.

**Expected.** A server built the standard way with the official SDK works with Alexa+ as-is, or the docs call out
that it must run stateless.

**Actual.** The stateful SDK server rejects those requests with HTTP 400 and the JSON-RPC error
`Bad Request: No valid session ID provided`. A server that follows the SDK's default example would fail every
Alexa+ call after `initialize`.

**Severity.** Major. Every tool call would fail, and nothing in the error points to the cause.

**Workaround.** A stateless fallback in `apps/mcp-server/src/http.ts`. An authenticated non-initialize POST that has no
`Mcp-Session-Id` is served by a one-shot server and transport (`sessionIdGenerator: undefined`,
`enableJsonResponse: true`). Clients that do send a session id (our simulated host, MCP Inspector) keep full stateful
sessions with notifications. An unknown session id still returns 404, and unauthenticated requests still return
401 without `WWW-Authenticate`. Covered by `apps/mcp-server/src/stateless.test.ts`.

**Suggestion.** Add a "Server requirements" box to the MCP QuickStart: "Alexa+ does not keep `Mcp-Session-Id`;
run your Streamable HTTP server stateless (`sessionIdGenerator: undefined`) or accept session-less requests." Make
the stated spec version and the version the client sends agree, or explain why they differ.

---

## 3. Account linking documentation: ordering problem, undocumented schema, unspecified client auth

**Task.** Configure OAuth account linking between Alexa+ and Stand-In's built-in OAuth 2.1 server, following
"Account Linking for MCP Add-ons", "Authentication" and the "Alexa AI CLI reference" pages
(`https://developer.amazon.com/docs/alexaplus/add-ons/`).

**Steps taken.**
1. Prepared the server's OAuth client: client ID, secret and an exact-match redirect URI allowlist
   (`OAUTH_REDIRECT_URIS`).
2. Planned `alexa-ai configure-account-linking`, first with `--config-file`, then with `--client-id` and the masked
   secret prompt.
3. Tried to decide token-endpoint client authentication and whether to support the Tier 1 `client_credentials` grant.

**Expected.** The docs list Alexa's redirect URIs (or their hosts) up front, publish the `--config-file` JSON schema,
state the token endpoint auth method, and say clearly when the Tier 1 grant is used.

**Actual.**
- **Ordering problem with redirect URIs.** Alexa's redirect URIs are shown only after running
  `configure-account-linking` (or in the Developer Hub). No fixed list or host pattern is published. A server that
  checks redirect URIs exactly, as OAuth 2.1 requires, cannot be fully configured before the CLI step, so the server
  has to be reconfigured and redeployed afterwards.
- **`--config-file` schema not published.** The CLI reference lists the flag, but not the file's format.
- **Client authentication unspecified.** The docs' sample token request carries no client secret. They do not say
  whether Alexa uses `client_secret_basic`, `client_secret_post`, or acts as a public PKCE-only client.
- **Tier 1 `client_credentials` is ambiguous for public servers.** The Authentication page describes Tier 1 for a
  *private* MCP server, but also says it "must be established before user-level account linking occurs" and that
  initialize/tools/list use it. It is unclear whether a public server must implement it for `alexa-ai deploy` tool
  discovery.
- **Scopes.** The example uses `openid`, but OIDC is listed as unsupported.

**Severity.** Major. Each gap is a likely `invalid_client` or "redirect URI not registered" failure that is only found
during a live linking attempt.

**Workaround.** Each choice is configurable in `.env` and documented under "Open questions" in
`alexa-addon/README.md`. The token endpoint accepts both `client_secret_basic` and `client_secret_post`. A PKCE-only
public client is allowed only on a loopback dev server. `OAUTH_CLIENT_CREDENTIALS=true` and `MCP_PUBLIC_DISCOVERY=true`
make discovery work with or without a Tier 1 token, while `tools/call` without a user token still returns 401. The
server advertises only the `standin` scope. The guide uses `--client-id` with the masked prompt instead of
`--config-file`.

**Suggestion.** Publish (a) the redirect URI list or host pattern per region, so servers can allowlist before running
the CLI, (b) the `--config-file` JSON schema with an example, (c) the exact `token_endpoint_auth_method` Alexa uses,
and (d) a decision table: "public vs. private server → is Tier 1 `client_credentials` required for discovery?".

---

## 4. `@modelcontextprotocol/ext-apps` 2.x server helpers target the newer server package, not SDK 1.x

**Task.** Render the MCP Apps call card (`ui://standin/call-card`, `text/html;profile=mcp-app`) next to tool results,
using `@modelcontextprotocol/ext-apps` 2.0.3 alongside `@modelcontextprotocol/sdk` 1.32.1.

**Steps taken.**
1. Checked the ext-apps server helpers for registering the UI resource and linking it from tool `_meta`.
2. Tried the ext-apps AppBridge on the host side (`apps/alexa-sim`) to render the card.

**Expected.** The ext-apps helpers work with the current stable SDK (1.x), and the AppBridge renders the card.

**Actual.** The ext-apps 2.x server helpers target the newer `@modelcontextprotocol/server` package's `McpServer`, not
SDK 1.x's. With the AppBridge on the host side, the card did not appear.

**Severity.** Minor. Spec-level interop works; only the helper layer did not.

**Workaround.** The server sets the ext-apps conventions by hand: `_meta.ui.resourceUri` plus the legacy
`_meta["ui/resourceUri"]`, MIME `text/html;profile=mcp-app` (`apps/mcp-server/src/mcp.ts`, `apps/mcp-server/src/card.ts`).
The host uses a small hand-written postMessage JSON-RPC bridge that follows the ext-apps message types
(`apps/alexa-sim/src/lib/card-bridge.ts`). The card runs in a sandboxed srcdoc iframe, and the tools it may call are
limited to an allowlist.

**Suggestion.** State the supported MCP SDK major version in the ext-apps README and on npm (peer dependency), and
either ship a thin SDK 1.x adapter or a migration note, with a minimal end-to-end sample (server helper + AppBridge
host) on the SDK 1.x line.

---

## 5. New AWS account activation: payment card Error 880104 blocks Bedrock and deployment

**Task.** Activate a new AWS account to run the AWS path: Amazon Bedrock Converse
(`us.anthropic.claude-haiku-5-5` inference profile, `us-east-1`), Amazon Polly neural voices, and the Lightsail container
service deploy (`scripts/deploy-lightsail.sh`).

**Steps taken.**
1. Created the account and added a payment card in the billing console. Retried several times.
2. Called Bedrock Converse with the runtime credentials.

**Expected.** The card is accepted, or rejected with a reason the account holder can act on (wrong address, card type
not supported, bank declined). After that, Bedrock calls succeed.

**Actual.**
- Every card attempt failed with: `Error 880104: Sorry, there was an error processing your request`. No reason and no
  next step.
- Bedrock Converse returned `AccessDeniedException`: "Your account is currently being verified".
- The account stayed in verification, which also blocked the live deployment.

**Severity.** Blocker for the live AWS deployment and for real Bedrock calls during the hackathon window.

**Workaround.**
- Every provider has an offline implementation. A deterministic scripted policy and browser TTS run with no AWS keys.
  The OpenAI API is used only for local development and eval, never in `aws` mode.
- The Bedrock provider stays wired and is covered by tests with a mocked Converse client, including mapping
  `AccessDeniedException` to a provider error (`packages/providers/src/llm/bedrock.test.ts`). In `aws` mode, Bedrock
  calls share a global hourly and daily budget; when it is spent, the planner falls back to the scripted policy.
- Deployment artifacts are ready to run once the account clears: Dockerfile (linux/amd64),
  `scripts/deploy-lightsail.sh`, `scripts/smoke-live.sh`, and a least-privilege IAM policy
  (`infra/iam-standin-runtime-policy.json`).
- Raised the account verification issue with AWS Support.
- Live URL: <LIVE_URL> (TODO: fill in after the account is verified and deployed).

**Suggestion.** Return an error that says what to do: which field failed (card network, billing address, 3-D
Secure/bank decline, region), and a link to open a verification support case from the error page. Show the account's
verification state, with an estimated time to clear, on the Bedrock console, so that "currently being verified" is
not first discovered as an `AccessDeniedException` at runtime.
