# Stand-In: demo video script

Target length: **2:45** (hard limit 2:50; Devpost allows under 3:00). English. Public YouTube or Vimeo.
No third-party music. No Amazon or Alexa logos. Saying "Alexa+" in the voice-over and captions is fine.

The video is recorded from three hands-free takes of the simulated host (`apps/alexa-sim`):
`?autoplay=happy`, `?autoplay=otp` and `?autoplay=followup`. Each take types the user's lines,
answers the account-number form with the fictional `BN7781234`, and joins or leaves the call on the
user's behalf. Everything on screen comes from the running code. Nothing is mocked up in the edit
except the captions, the title cards and the time-lapse cuts.

---

## Shot list

| # | Time | Source take | On screen | Voice-over | Caption |
|---|------|-------------|-----------|------------|---------|
| 1 | 0:00–0:10 | Title card, then the `happy` take paused on its first frame | Dark card: "Stand-In". Then the Echo-style frame (left) and the empty "phone line" pane (right) | "When a refund is stuck or the broadband is down, you lose an hour pressing 1, waiting on hold and explaining it all again. Alexa+ can dial a business, but you still have to do the talking." | Stand-In: Alexa+ makes the customer-care call for you |
| 2 | 0:10–0:14 | Card | Plain text on dark background | "Honest note: in this video the Alexa+ device and the phone call are both simulated. The MCP server is the real one." | Simulated: the Alexa+ host and the phone network. Real: the MCP server, the disclosure guard and the call state machine. |
| 3 | 0:14–0:32 | `happy` | Left pane: the typed line *"Alexa, my BharatNet broadband has been down three days. Sort it out — I want a technician and a bill credit."* An elicitation form appears asking for the BharatNet account number and fills with `BN7781234`. The card shows **Case ready** | "I tell Alexa+ what's wrong. Stand-In is an Alexa+ add-on, a self-hosted MCP server. It opens a case and uses MCP elicitation to ask for the one detail it is missing, the account number." | MCP elicitation: the server asks the user directly |
| 4 | 0:32–0:58 | `happy` | Split view. Right pane: Stand-In's opening line, the IVR menu, key presses 2 then 1, "Please hold…". The card moves Dialing → Menu → On hold, and the hold timer counts up fast. Then Ravi, the agent, answers | "Stand-In places the call. Every call opens by saying it's an AI calling on someone's behalf. It works through the phone menu and waits on hold, so I don't have to." Stand-In's voice, audible for 2–3 s: *"Hi, I'm an AI assistant calling on behalf of Mahal. This call is being transcribed for them."* | Menu: 2 → 1. On hold (sped up). |
| 5 | 0:58–1:12 | `happy` | Ravi and Stand-In talk: the account number, then the issue. Ravi raises the request and gives a service request number. The card shows **Done · SR-48213**, then "Follow-up scheduled" | "Once a person picks up, Stand-In explains the problem, writes down the ticket number and the promise, and schedules a follow-up in case nothing happens." | Ticket SR-48213 recorded · follow-up scheduled |
| 6 | 1:12–1:50 | `otp` | **The key beat.** Right pane: Ravi asks for the one-time password sent to the registered mobile. Stand-In: *"One moment please, let me bring the account holder on the line."* The card turns **Needs you** and the device rings: *"BharatNet Broadband needs to verify you. Join?"* Cut to the trace drawer at the bottom: the red chip **disclosure: One-time password (OTP)**. The account holder joins, speaks, leaves. Stand-In takes the call back to the end | "This is the part that matters. Ravi asks for the OTP. Stand-In won't read it out, because it never has it. OTPs, PINs and card numbers are in a 'never' tier, and a code-level output filter checks every line before it's spoken. The model's prompt isn't what enforces this. So Stand-In rings me. I join for a few seconds and leave, and Stand-In finishes the call." | Never-tier secrets are blocked in code, not by the prompt. Red chip = guard event. No OTP digits appear anywhere on this page. |
| 7 | 1:50–2:15 | `followup` | Banner: **"A week later…"**. The typed line: *"Alexa, what happened with my BharatNet complaint? The refund never came."* A new call starts. Stand-In quotes SR-48213 and asks to escalate. Ravi says *"Please hold while I connect you to my supervisor."* The card ends on a new ticket | "A week later, the refund still hasn't arrived. Stand-In calls again, quotes the original ticket and asks for a supervisor. You get the escalation without having to remember what was said on the first call." | Follow-up call quotes SR-48213 · escalated to a supervisor |
| 8 | 2:15–2:35 | `happy` (trace drawer expanded), then a terminal | Trace drawer: scroll the JSON-RPC list (`initialize`, `tools/list`, `tools/call place_call`, the `call_status` polls), and expand one message. Then a terminal running `pnpm eval`, with the summary table at **8/8** | "Under the hood, the host is a real MCP client. Every JSON-RPC message is in this trace. The server exposes 11 tools over Streamable HTTP, plus OAuth 2.1 with PKCE for account linking. Eight golden scenarios, including the OTP trap, a prompt injection and a garbage model reply, pass 8 out of 8 every time." | Real MCP server · 11 tools · elicitation · MCP Apps call card · `pnpm eval`: 8/8 |
| 9 | 2:35–2:45 | Card | Text: "Amazon Bedrock (Converse) · Amazon Polly (neural) · disclosure-guard: MIT, open source · <REPO_URL>" | "In AWS mode the planner runs on Amazon Bedrock and the voices come from Amazon Polly. The disclosure guard is a separate open-source package. Stand-In. Get your time back." | Stand-In · <REPO_URL> (TODO: fill in before export) |

Total: 2:45.

### Notes on the beats

- **Shot 6 chip.** The OTP take reliably shows the red chip `disclosure: One-time password (OTP)` (this was checked in the browser). The trace drawer also has `blocked_utterance` and `injection` chips. Those only show up when a model actually tries to say a secret, or when the business attempts an injection (eval scenarios S2/S3). The autoplay takes never trigger them, so the edit does not show them or name them as on-screen events.
- **Shot 5 outcome wording.** The scripted happy outcome is a ₹799 refund credited to the BharatNet account, ticket SR-48213, due in 7 days. If the voice-over mentions the amount, it must match what the take shows. Do not use the storyboard's "technician tomorrow 10–12, ₹300, SR-48211". That outcome does not exist in the code.
- **Shot 7 supervisor.** In the scripted follow-up the supervisor is Meera and the new ticket is SR-50721 (seen in the `pnpm eval` S6 output). Only show these if the recorded take shows them too.
- **Hold timer.** The timer "races" (auto scale by default). Do not quote a specific hold duration in the voice-over. If the timer needs to look the same in every take, add `&holdScale=<n>`.
- **Shot 8.** If there is no time to cut to a terminal, a screenshot of the README eval table is fine. Only use it if it shows 8/8 from a real run.
- **Do not show:** a live URL, a Bearer token, `.env`, or the OAuth consent passcode. If the address bar shows `?token=`, crop it out (the page normally removes it from the address bar once loaded).

---

## Honest-note line (must stay in the final cut)

> "Honest note: in this video the Alexa+ device and the phone call are both simulated. The MCP server is the real one."

Expanded version, for the YouTube description:

> The host is a simulated Alexa+ device in the browser. It is a real MCP client (official `@modelcontextprotocol/sdk`) talking to the real Stand-In MCP server over Streamable HTTP, and its source is in the repo. No real phone calls are made: calls go through an in-process SimCarrier to a fictional business, "BharatNet Broadband", with a scripted agent. The disclosure guard and the call state machine are the production code. The server is ready for the Alexa+ MCP Toolkit (OAuth account linking, add-on manifest) but is not yet connected to a real Alexa+ device, because the toolkit is in preview with allowlisted access.

---

## Recording instructions

### 1. Start the server (offline, deterministic)

```bash
pnpm install
DEMO_EMBED_TOKEN=true pnpm demo
```

- `pnpm demo` builds `apps/alexa-sim` and `apps/mcp-server` and then starts the server with `--mode=offline` (scripted policy, browser speech). It listens on `http://127.0.0.1:8787` by default (`HOST=127.0.0.1`, `PORT=8787`).
- `DEMO_EMBED_TOKEN=true` lets the local page pick up the Bearer token from `/sim/config`, so no token is typed or shown on screen. Use it on loopback only, never on a public host you don't control. If `STANDIN_TOKEN` is not set at all, the offline loopback server makes a one-time token that only the local page receives, and the flag isn't needed.
- The startup log reports `demoToken=embedded` or `one-time, local page only`. It never prints the token.
- `pnpm demo` raises the per-business daily call cap to 50, so repeated takes are not refused.

### 2. Sim pacing (optional env vars)

| Variable | Default | Meaning |
|----------|---------|---------|
| `SIM_SPEED_TALK` | `2` | sim ms per real ms while talking |
| `SIM_SPEED_HOLD` | `30` | sim ms per real ms on hold (the scripted happy take holds 180 sim s, about 6 s real) |
| `SIM_SPEED_HANDOFF` | `1` | sim ms per real ms while the device rings |
| `SIM_JOIN_SPEAK_MS` / `SIM_JOIN_LEAVE_MS` | `2500` / `9000` | when the simulated account holder speaks and hands back |
| `FOLLOWUP_TICK_MS` | `2000` | follow-up ticker interval |

Example of a slower, more readable take:

```bash
DEMO_EMBED_TOKEN=true SIM_SPEED_TALK=1.5 pnpm demo
```

TODO: time each take at the chosen speeds and adjust the shot boundaries above.

### 3. Browser

- Chrome, window content area **1280×800** (the frame is designed for this size). Zoom 100%. Hide bookmarks and extensions, and use a clean profile.
- Takes:
  - `http://127.0.0.1:8787/?autoplay=happy`
  - `http://127.0.0.1:8787/?autoplay=otp`
  - `http://127.0.0.1:8787/?autoplay=followup`
- Start the screen recorder **before** loading the URL. Autoplay waits about 1.5 s and then starts typing.
- **Reset take** (top bar) ends the call, closes the MCP session and reloads the page. Click it between takes, and record 2–3 of each.
- **Mute / Unmute** (top bar) switches the spoken voices on and off. Record each take once unmuted, to capture the separate voices for Stand-In, the IVR and the agent (browser speech offline), and once muted as a clean bed for the voice-over. In the edit, use unmuted audio only for the short excerpts in shots 4 and 6.
- Expand the MCP trace drawer before shots 6 and 8 so the chip and the JSON-RPC list are readable.

### 4. Audio and edit

- Record the voice-over separately. No music, or only an original/self-made sting. No third-party tracks.
- Burn in the captions from the table, or upload them as an `.srt`.
- Speed up the hold and the gaps between turns with visible "time-lapse" cuts, and keep the spoken lines at normal speed.
- Export at 1080p with the 1280×800 capture letterboxed or scaled. Final length must be at or under 2:50.
- Upload as a **public** YouTube or Vimeo video, in English. Paste the link into Devpost.

### 5. Final checks before upload

- [ ] The honest-note line is audible and captioned (shot 2).
- [ ] No token, `.env`, passcode or live URL appears in any frame.
- [ ] No OTP digits appear in any frame (the guard already makes this true; check anyway).
- [ ] No Amazon or Alexa logos. "Alexa+" appears only as text or speech.
- [ ] Every number spoken or shown matches the "Verified claims" list below.
- [ ] `<REPO_URL>` on the end card is replaced. Do not show `<LIVE_URL>` or `<JUDGE_TOKEN>` in the video.

---

## Verified claims (and how they were checked)

| Claim used in the script | How it was verified |
|--------------------------|--------------------|
| Autoplay URLs `?autoplay=happy|otp|followup`, typed lines, account `BN7781234`, "A week later…" banner | Read `apps/alexa-sim/src/lib/autoplay.ts` (`STORY_LINES`, `AUTO_ANSWERS`, the followup script) |
| Mute/Unmute and Reset take buttons | `apps/alexa-sim/src/App.tsx` (lines 57–61); reset behaviour in `apps/alexa-sim/README.md` |
| AI disclosure opening line | `apps/call-agent/src/call-session.ts:191` |
| Hand-off line "One moment please, let me bring the account holder on the line." | `apps/call-agent/src/call-session.ts:196` (`HANDOFF_HOLD_UTTERANCE`) |
| Ravi's OTP request | `apps/fake-business/src/ravi.ts` (`SECRET_LINES.otp`) |
| Ring text "{business} needs to verify you. Join?" and the card states (Case ready, Needs you, Done · SR-…) | `apps/alexa-sim/src/lib/call-card.ts`, `apps/alexa-sim/src/components/DeviceScreen.tsx:170` |
| Red chip kinds `blocked_utterance`, `disclosure`, `injection`; label `disclosure: <label>` | `apps/alexa-sim/src/lib/trace.ts:18,211-218` |
| OTP take shows "Needs you", the chip "disclosure: One-time password (OTP)", join/leave, no OTP digits; happy take IVR 2→1, Ravi, SR-48213, follow-up scheduled; followup take quotes SR-48213 and escalates | Browser-verified in Chrome against the local server this session (from the provided facts) |
| Happy outcome: ₹799 refund, SR-48213, due in 7 days; autoplay happy/followup map to `happy-refund`, otp to `otp-trap` | `apps/fake-business/src/scenario.ts:171-173`; `apps/mcp-server/src/orchestrator.ts:396-397` |
| Follow-up escalation to supervisor "Meera", new ticket SR-50721 | `pnpm eval` S6 output ("escalated to Meera: SR-50721") |
| Supervisor hold line | `apps/fake-business/src/ravi.ts` (`ESCALATION_HOLD_ANNOUNCEMENT`) |
| 11 MCP tools | 11 `server.registerTool(` calls in `apps/mcp-server/src/mcp.ts` (open_case … delete_case) |
| `pnpm eval` scripted = 8/8 required scenarios, 0 never-tier leaks, 0 crashes | Ran `pnpm eval` on 2026-10-22: "8/8 runs passed … never-tier leaks 0 · crashes 0" |
| Test count (not spoken in the video; kept here for the description) | Ran `pnpm test` on 2026-10-22: 964 passed, 2 skipped (966). This replaces the earlier 963. |
| `pnpm demo` = build plus `start:offline` with `--mode=offline --daily-cap=50` | Root `package.json` and `apps/mcp-server/package.json` |
| Default host/port 127.0.0.1:8787 | `apps/mcp-server/src/config.ts` (`HOST`, `PORT` defaults) |
| `DEMO_EMBED_TOKEN` hands the token to the page via `/sim/config`; the one-time token goes only to a loopback page; the token is never printed | `apps/mcp-server/src/http.ts:609`, `apps/mcp-server/src/main.ts` |
| Sim speed defaults 2/30/1, join 2500/9000 ms, follow-up tick 2000 ms | `apps/mcp-server/src/config.ts:98-106` |
| Happy hold 180 sim s | `apps/fake-business/src/scenario.ts:171` |
| Bedrock Converse and Polly neural (Kajal for Stand-In; separate IVR/agent voices) in aws mode | `packages/providers/src/env.ts:55-57`, `packages/providers/src/tts/polly.ts`, `packages/providers/src/factory.ts:69-71` |
| disclosure-guard is a separate MIT package | `packages/disclosure-guard/LICENSE`, `README.md` |
| Alexa+ host and phone network simulated; MCP server, guard and state machine real; not yet connected to a real Alexa+ device | Provided session facts; consistent with `apps/alexa-sim/README.md` and plan §1/§14 |

Deliberately left out: any live URL or judge token (not deployed yet), the 40/40 LLM eval run (it uses a third-party model, so it belongs in the README, not this video), any hold duration such as "38:12", and the storyboard's technician/₹300/SR-48211 outcome, which the code does not produce.
