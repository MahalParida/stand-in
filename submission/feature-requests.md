# Feature requests: Stand-In

Stand-In is an Alexa+ add-on: a self-hosted MCP server. It places a customer-care call for the user, waits on hold, talks to the agent, and hands the call back to the user when only they can answer, for example an OTP. Each request below comes from something we ran into while building it (the matching friction entries are in the friction log in `submission/`) or from something the product needs and could not get from the platform.

Urgency scale: **critical** (blocks shipping), **important** (costs days or forces a workaround), **nice-to-have** (would make the product better).

| # | Request | Product | Urgency |
| :-- | :-- | :-- | :-- |
| 1 | Self-serve access to the Alexa+ MCP Toolkit and a public Alexa AI CLI | Alexa+ add-ons | Critical |
| 2 | Documented session semantics and protocol version for the Alexa+ MCP client | Alexa+ add-ons | Important |
| 3 | Account-linking setup that shows redirect URIs up front and has a published config schema | Alexa+ add-ons / Alexa AI CLI | Important |
| 4 | A way for an add-on to notify or "ring" the user during a long-running task | Alexa+ add-ons | Important |
| 5 | A published MCP Apps rendering contract for Echo Show, plus a reference host | Alexa+ add-ons | Nice-to-have |
| 6 | An outbound-calling primitive that add-ons can use | Alexa+ add-ons | Nice-to-have |

---

## 1. Self-serve access to the Alexa+ MCP Toolkit and a public Alexa AI CLI

**Urgency: critical**

**What we're asking for**
- A sign-up flow in the developer console that grants the Alexa AI CLI and the add-on section. Today you get the CLI by assuming a cross-account role into Amazon's account and pulling from a private CodeArtifact registry.
- The CLI published on a public registry (npm or similar), with access controlled by the developer account and not by an IAM allowlist.
- When a developer is not allowlisted, an error that says so and names the next step. We got a plain `AccessDenied` on `AssumeRole` for the `AddOn3PDeveloperToolsRead` role, with no guidance.
- A published timeline for regions outside the US. The toolkit is currently preview and US-only.

**Why it matters**
Stand-In's server is ready for Alexa+: OAuth 2.1 account linking, an `addon.json` template, listing assets, and privacy and terms pages (`alexa-addon/`). It is still not connected to a real Alexa+ device, because we could not get the CLI and the developer console shows no add-on section for our account. For the hackathon we built a simulated Alexa+ host that is a real MCP client (`apps/alexa-sim`). That host is allowed by the rules, but the real-device path, which is the most convincing one, was closed to us. The product targets India, where IVR menus and long holds are a daily problem. A US-only preview means the developers closest to that problem cannot test on a device.

---

## 2. Documented session semantics and protocol version for the Alexa+ MCP client

**Urgency: important**

**What we're asking for**
- One authoritative statement of the `protocolVersion` the Alexa+ client sends. The docs say spec `2025-11-25`, but they also describe the client sending `2025-03-26`.
- A statement of whether the client keeps the `Mcp-Session-Id` header and when: per user, per add-on, per conversation, or never.
- If the client is stateless, say so in the QuickStart, and name a server pattern that works with the official TypeScript SDK.
- Whether server-to-client features that depend on a session or stream (elicitation, `notifications/resources/updated`, progress) reach the user, and how.

**Why it matters**
The client is documented as keeping no MCP session id per add-on. A standard stateful server built with `@modelcontextprotocol/sdk` (we use 1.32.1) rejects a non-initialize request that has no session id with HTTP 400 "Bad Request: No valid session ID provided". We added a stateless fallback in `apps/mcp-server/src/http.ts`: a one-shot server and transport for authenticated requests that arrive without a session id. That fallback cannot send notifications. Because Stand-In runs long calls, this affects the design directly. Mid-call questions and OTP hand-offs have to go through `call_status` polling (`pendingQuestion`, `state: HANDOFF_PENDING`), not through server pushes. We made that choice without knowing what the real client does.

---

## 3. Account-linking setup that shows redirect URIs up front and has a published config schema

**Urgency: important**

**What we're asking for**
- Show the add-on's Alexa redirect URIs (the `https://alexa.amazon.com/api/skill/link/<vendor-id>` family) in the developer console before `alexa-ai configure-account-linking` runs, or give them a fixed, documented list. Today they are printed only by that command. A server that allowlists redirect URIs exactly needs them before linking can succeed.
- Publish a JSON schema for `configure-account-linking --config-file`. The CLI reference documents the flag but not the file format.
- State which client authentication method the Alexa token client uses at `/token`: `client_secret_basic`, `client_secret_post`, or a public PKCE-only client. The sample token request in the docs has no secret.
- Clarify whether the Tier 1 `client_credentials` grant (`mcp:service`, used for `initialize` and `tools/list` during `alexa-ai deploy`) is required for a public MCP server or only for a private one. The Authentication page describes it for private servers, but also says it must exist before user-level account linking.
- Resolve the scope example. It uses `openid`, while OIDC is listed as unsupported.

**Why it matters**
Each gap forced us to guess and to make the server accept several answers. Stand-In accepts both `client_secret_basic` and `client_secret_post`, and offers both the Tier 1 grant (`OAUTH_CLIENT_CREDENTIALS=true`) and unauthenticated discovery (`MCP_PUBLIC_DISCOVERY=true`), so that deploy-time tool discovery works whichever way Alexa behaves. Every one of these switches is more surface to secure and test. The open questions are listed in `alexa-addon/README.md` under "Open questions".

---

## 4. A way for an add-on to notify or "ring" the user during a long-running task

**Urgency: important**

**What we're asking for**
A documented, permissioned way for an MCP add-on to get the user's attention after the original utterance has finished. For example:
- a proactive notification (a chime, a banner on Echo Show, or an Alexa app push) that the add-on triggers with a short, structured payload, and
- a "ring the user" variant for time-sensitive hand-offs, which opens a voice prompt the user can accept or decline.

Rate limits, per-add-on user consent, and a required reason field would all be reasonable conditions.

**Why it matters**
A Stand-In call can sit on hold for a long time. The moment that matters is when the agent asks for something only the user can give, such as an OTP or an identity check. The disclosure guard refuses to speak never-tier values like OTPs, so the call moves to `HANDOFF_PENDING` and waits for the user. In our simulated host the call card shows "Needs you" and the user joins. On a real device we found no documented way, in the add-on docs we used (MCP QuickStart, Account Linking, Authentication, Alexa AI CLI reference, Web Simulator), for an add-on to reach a user who has walked away. Without that, the user has to keep asking "how's my call going", and the agent's patience on the other end runs out. The server already returns rich structured fields (`ticketId`, `dueBy`, `summary`, `pendingQuestion`) that could fill such a notification.

---

## 5. A published MCP Apps rendering contract for Echo Show, plus a reference host

**Urgency: nice-to-have**

**What we're asking for**
- Say whether Alexa+ renders MCP Apps UI resources (`ui://…`, `text/html;profile=mcp-app`) on screen devices, which postMessage methods the host supports (tool calls from the view, `host-context-changed` theme data, size changes), and the viewport sizes involved.
- Add a reference host, or MCP Apps preview support in the Web Simulator, so a developer can check a card without a device.
- Coordinate with the MCP Apps maintainers on a host bridge that works with the widely deployed `@modelcontextprotocol/sdk` 1.x. The `@modelcontextprotocol/ext-apps` 2.x server helpers target the newer `@modelcontextprotocol/server` package.

**Why it matters**
Stand-In's call card (`ui://standin/call-card`) is the screen for the whole call: Preparing, Dialing, Menu, On hold, Talking, Needs you, Done. When we tried the ext-apps AppBridge path, the card did not render. We wrote a small postMessage bridge by hand, following the ext-apps message types (`apps/mcp-server/src/card.ts` for the view, `apps/alexa-sim/src/lib/card-bridge.ts` for the host). It works in our simulated host. We still don't know whether a real Echo Show would show it.

---

## 6. An outbound-calling primitive that add-ons can use

**Urgency: nice-to-have**

**What we're asking for**
A permissioned capability that lets an add-on place an outbound call on the user's behalf and exchange audio or text with it: send DTMF digits, receive transcribed speech from the callee, send speech to the callee, and hand the live call to the user's device. It should carry Amazon-enforced safeguards: a verified-business or allowlisted-number requirement, calling-hours limits, a mandatory AI-disclosure line, and per-user consent.

**Why it matters**
Today an add-on that wants to make phone calls has to bring its own telephony provider and its own consent and anti-abuse controls. Stand-In already enforces these in code: a dial allowlist (`data/business-directory.json`), calling hours checked in IST, an "I'm an AI assistant calling on behalf of…" opening line, and a disclosure guard on every outbound utterance. All of that runs against a `Carrier` interface. The only carrier we built is simulated (`SimCarrier`, which calls a fake business, "BharatNet Broadband"). We did not build a real PSTN carrier. A platform primitive would let add-ons like this place real calls without each developer rebuilding telephony and abuse controls, and the call could hand off to the Echo the user is already standing next to.
