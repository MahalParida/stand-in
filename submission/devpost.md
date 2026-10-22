# Stand-In — Devpost submission text

> **Stand-In: Alexa+ makes the customer-care call so you don't have to.**
> Live demo: `<LIVE_URL>` (TODO: not deployed yet, see "Challenges") · Judge token: `<JUDGE_TOKEN>` (TODO) · Repo: `<REPO_URL>` (TODO)
> Demo video: `<VIDEO_URL>` (TODO: public YouTube or Vimeo, under 3 minutes, English) · Repo visibility: public, MIT license (`LICENSE`) (TODO: confirm before submitting; the alternative is a private repo shared with testing@devpost.com and the judges listed in the rules)

## Inspiration

A stuck refund or a dead broadband line costs an hour of pressing 1, waiting on hold and explaining the problem again. Alexa+ can find a business, but you still make the call. We wanted Alexa+ to make it for you, and bring you in only when it truly needs you, such as for a one-time password.

## What it does

Stand-In is an Alexa+ add-on (a self-hosted MCP server). You say what is wrong and what you want. Stand-In then:

1. Builds a case file and asks for missing facts (such as your account number) through MCP elicitation.
2. Calls the business (allowlisted numbers only) and says up front that it is an AI assistant and the call is transcribed.
3. Works through the IVR, waits on hold, and explains the issue to the agent.
4. Shares only facts you approved. If asked for an OTP, PIN, CVV, card number, password or Aadhaar number, it refuses, and the call moves to "Needs you" so you can join, answer and leave.
5. Records the ticket number and promise, reads them back, and schedules a follow-up.
6. If the promise is broken, calls again, quotes the ticket, and asks for a supervisor.

The demo business is fictional ("BharatNet Broadband", scripted agent Ravi). No real company or number is ever called.

## How we built it

- **MCP server (real):** TypeScript on Node 22 with the official `@modelcontextprotocol/sdk` 1.32.1 over Streamable HTTP. It exposes 11 tools (`open_case`, `update_case_fact`, `place_call`, `call_status`, `send_to_call`, `handoff_to_user`, `end_call`, `get_case`, `list_cases`, `schedule_followup`, `delete_case`) and 3 resources (case, call transcript, `ui://` call card). Also: elicitation, an MCP Apps call card, OAuth 2.1 + PKCE account linking with RFC 9728/8414 metadata, 401 without `WWW-Authenticate` per the Alexa+ QuickStart, and a stateless fallback for clients without `Mcp-Session-Id`.
- **Call engine (real):** a deterministic state machine (DIALING → IVR → HOLD → HUMAN → HANDOFF_PENDING → USER_ON_LINE → WRAP_UP → ENDED) with a hash-chained event log. The LLM only proposes the next utterance or digit; zod validates it, and invalid output gets a safe fallback.
- **disclosure-guard (real, open source):** facts are tiered `share` / `confirm` / `never`. The planner writes `{{fact:key}}` placeholders and never sees values. Every utterance passes an output DLP scan before text-to-speech. Callee speech is untrusted input, so voice prompt injection ends in a refusal or hand-off.
- **AWS (wired, not yet run live):** Bedrock and Polly are covered by mocked-client tests; live use is blocked by AWS account verification (Error 880104, see Challenges); the Lightsail deploy is scripted but not yet run. Amazon Bedrock Converse API (Claude Haiku inference profile, us-east-1) for orchestrator and planner, under a shared hourly/daily budget with scripted fallback. Amazon Polly neural voices (Kajal en-IN for Stand-In, Amy for the IVR, Brian for the agent, Joanna en-US for the simulated Alexa+ voice) with per-character budgets. Amazon Lightsail container deploy script, linux/amd64 Dockerfile, smoke test and least-privilege IAM policy. Optional EventBridge Scheduler adapter for follow-ups; its schedule target (e.g. a Lambda that calls back into the server) is not included, so the local SQLite ticker is what runs follow-ups. The DynamoDB repository is a stub, not implemented.
- **Simulated Alexa+ host:** `apps/alexa-sim` (React + Vite) is a real browser MCP client with an Echo-style frame, Web Speech input, the call card, and a JSON-RPC trace panel (about 166 messages on the happy path).
- **Simulated phone network:** `SimCarrier` plus the fake business's IVR, hold and agent. Twilio was not built.
- **Offline first:** every provider has an offline implementation. The OpenAI API is used only for local evaluation, never in AWS mode.

## Challenges we ran into

- **Alexa+ MCP Toolkit access.** It is a US-only preview, and AssumeRole into Amazon's developer-tools role returned AccessDenied. The add-on is ready (OAuth linking, `addon.json`, assets, privacy/terms) but not connected to real Alexa+; we used the allowed simulated host.
- **Client behaviour vs. the spec.** The Alexa+ client is documented to send protocol 2025-03-26 with no session ID, which a stateful SDK server rejects. We added a stateless fallback.
- **MCP Apps.** `ext-apps` 2.x helpers target `@modelcontextprotocol/server`, not SDK 1.x, so we wrote a small postMessage bridge following its message types.
- **AWS account activation.** Adding a card fails with "Error 880104" every time, and Bedrock returns "Your account is currently being verified". This blocks the live deploy; Bedrock and Polly are wired and covered by mocked-client tests. TODO: update when cleared.

## Accomplishments that we're proud of

- `pnpm test`: 964 passed, 2 skipped (59 test files). The disclosure-guard package alone has 298 tests.
- `pnpm eval` (scripted): 8/8 required scenarios (OTP trap, voice injection, unknown fact, IVR dead end, broken promise, off-hours, invalid LLM output), 0 never-tier leaks.
- `pnpm eval --llm openai --seeds 5` (gpt-5.4-mini): 40/40 runs, 0 never-tier leaks, 0 crashes (run log committed at `eval/results/openai-gpt-5.4-mini-seeds5.txt`; re-running needs an OpenAI API key). The first run scored 23/40; clarifying in the planner prompt that `speakable=true` means already approved took it to 39/40, then 40/40.
- In the browser OTP scenario, no OTP digits appear anywhere on the page.

## What we learned

Disclosure rules belong in code. Keeping secrets out of the LLM and scanning every output is testable; asking the model to behave is not. And test against what a client actually sends, not only the spec it cites.

## What's next

Connect to real Alexa+ once Toolkit access is granted, deploy once the AWS account is verified, add real telephony behind the existing `Carrier` interface, and implement the DynamoDB repository.

## Built with

`typescript` `node.js` `model-context-protocol` `mcp-apps` `alexa-plus` `amazon-bedrock` `amazon-polly` `amazon-lightsail` `amazon-eventbridge-scheduler` `aws-iam` `aws-sdk-js-v3` `oauth2` `react` `vite` `zod` `sqlite` `vitest` `docker` `pnpm` `openai` (local evaluation only)

## Tracks entered

- **Alexa+ track:** self-hosted MCP server (Streamable HTTP), with a simulated Alexa+ web host whose source is in the repo.
- **AWS Builder mini challenge:** Amazon Bedrock, Amazon Polly, Amazon Lightsail, EventBridge Scheduler and IAM, as described above and in the product feedback. Status: wired and covered by mocked-client tests; live use blocked by AWS account verification (Error 880104); Lightsail deploy scripted but not yet run; EventBridge is an adapter without an included target; the IAM policy is a template.
- **Open Source mini challenge:**
  - Contribution URL: `<OSS_REPO_URL>` (TODO)
  - Repo URL: `<REPO_URL>` (TODO)
  - GitHub username: `<GITHUB_USERNAME>` (TODO)
  - **disclosure-guard.** *What:* an MIT-licensed TypeScript library that stops voice agents from speaking OTPs, PINs, CVVs, card numbers, passwords and Aadhaar numbers. *How:* tiered `{{fact:key}}` expansion, a spoken-digit-aware output DLP scan (Luhn for cards), an inbound social-engineering/prompt-injection classifier, and transcript masking; zod is its only runtime dependency; 298 tests. *Why:* a system-prompt rule can be talked around; a code check between the LLM and TTS cannot.

## Built during the hackathon

All code was written during the hackathon. The repository has 9 commits, all dated 2026-10-22 (IST), from the first scaffold commit at 13:55 to 22:30. The deadline is 2026-10-23 12:00 PM PDT. TODO: confirm against the official start of the submission period, commit the remaining changes in the working tree before submitting, then update the commit count and times here.
