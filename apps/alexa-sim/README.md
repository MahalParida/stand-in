# @standin/alexa-sim — "Home Hub" simulated voice-assistant host

A browser host that stands in for an Alexa+ device (spec §8). It is a **real MCP client**
(`@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`) talking to the
Stand-In MCP server at same-origin `/mcp`. It uses a generic Echo-Show-style frame with no
third-party logos or trademarks.

- **Left: the device screen.** Shows the assistant's reply, a mic button (Web Speech API) with a text-box fallback, the call card and the hand-off "ring".
- **Right: "The phone line".** Shows what the business hears and says. Each speaker has its own voice: Stand-In, the IVR and the agent (Ravi). Offline mode uses browser `speechSynthesis`; aws mode plays Polly audio from `POST /sim/api/tts`.
- **Bottom: the MCP trace drawer.** Lists every JSON-RPC request, response and notification with its method, id and latency, and shows the JSON in a collapsible block. Guard events appear as red chips: `blocked_utterance`, `injection` and `disclosure`.
- **Take over call** calls `handoff_to_user` with `accept: true`.

## How it works

| Piece | File |
| :---- | :---- |
| MCP client, elicitation handler (form mode), `resources/updated` | `src/lib/mcp.ts` |
| Traced fetch (JSON and SSE via `tee`), masked payloads, chips | `src/lib/trace.ts` |
| Orchestrator loop: `POST /sim/api/llm` with messages + tool specs, then MCP `tools/call` | `src/lib/orchestrator.ts` |
| `ui://standin/call-card` in a sandboxed `srcdoc` iframe (MCP Apps postMessage bridge) | `src/lib/card-bridge.ts` |
| Native fallback card: `call_status` mapped to the 7 card states | `src/lib/call-card.ts`, `src/components/CallCard.tsx` |
| Autoplay scripts and auto-responders | `src/lib/autoplay.ts` |
| Host state, polling `call_status` every 1 s | `src/lib/controller.ts` |

The offline LLM is the deterministic scripted intent matcher, which runs on the server behind
`/sim/api/llm`. That keeps autoplay reproducible.

**Auth.** The token is taken from the first of these that is set:

1. `?token=`. The token is then stored in `sessionStorage` and removed from the address bar.
2. `demoToken` from `/sim/config`. The server only sends it when `DEMO_EMBED_TOKEN=true`.
3. A token typed once into the page, stored in `sessionStorage`.

The token is never logged or traced.

**Disclosure.** Before any text reaches the LLM proxy, the trace, the transcripts or TTS, it
goes through `@standin/disclosure-guard`'s `mask()`. That covers user text, elicitation
answers and every trace payload.

## Autoplay (hands-free recording)

`/?autoplay=happy|otp|followup` runs a take without anyone touching the page:

- It types the storyboard lines from §11.
- It answers the account-number elicitation and the mid-call account-number question with the fictional `BN7781234`.
- When the call needs you, it joins, and leaves about 3 s later if the server has not already handed back.
- The followup take also shows a "Two days later…" banner.
- The hold timer "races" ("38:12 on hold"). Use `?holdScale=<n>` to set a fixed factor. By default the scale is chosen automatically from how fast `holdSeconds` advances.
- **Reset take** ends the call, closes the MCP session and reloads the page.

## Run

```bash
pnpm --filter @standin/alexa-sim build      # emits dist/, served by apps/mcp-server at /
pnpm --filter @standin/alexa-sim dev        # Vite on :5173, proxies /mcp /sim /health /.well-known to 127.0.0.1:8787
pnpm --filter @standin/alexa-sim test       # vitest + happy-dom, no network
```

Set `STANDIN_BACKEND_URL` to point the dev proxy somewhere else.
