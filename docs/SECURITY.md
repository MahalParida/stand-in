# Security model (spec §13)

This is the source for the README's security section (M8).

| Threat | Control | Where |
| :--- | :--- | :--- |
| Agent leaks OTP/PIN/card | never-tier values are withheld from the LLM, plus output DLP and tests | `packages/disclosure-guard` |
| Social engineering / prompt injection by the callee | callee speech is treated as untrusted data; inbound classifier; hand-off; logged | `packages/disclosure-guard/src/inbound.ts`, `apps/call-agent` |
| Stand-In used to harass or spam | allowlisted directory, calling hours, per-business daily cap, AI disclosure | `data/business-directory.json`, `packages/core/src/policy.ts` |
| Scam number injection | numbers never come from the conversation or the LLM | `packages/core/src/policy.ts` |
| MCP endpoint abuse | Bearer token, Origin validation, 401 without `WWW-Authenticate`, per-IP rate limits; `/sim/api/*` request-shape limits and hourly and daily spend caps (Polly metered per character) | `apps/mcp-server/src/http.ts`, `apps/mcp-server/src/sim-guard.ts`, [DEPLOY.md](DEPLOY.md) |
| Transcript privacy | masked at write, 30-day TTL, per-case `delete_case` | `apps/call-agent/src/call-session.ts`, `apps/mcp-server` |
| Tampered history | hash-chained event log with a `verify` command | `packages/core/src/event-log.ts`, `packages/core/src/verify-store.ts` |

## Verifying the event log

Every call event stores `prevHash` and `hash = sha256(prevHash + canonical event)`, and the `events` table rejects
`UPDATE`. To check a stored database:

```bash
pnpm run verify --db ./standin.db              # every call
pnpm run verify --db ./standin.db --call <id>  # one call
```

The database path defaults to `$SQLITE_PATH`, then `./standin.db`. The command opens the file read-only, replays each
call's events in insertion order, and prints one line per call: `OK` with the event count and the head hash, or
`BROKEN` with the index and id of the first bad event and the reason (`hash_mismatch`, `prev_hash_mismatch`,
`call_id_mismatch`, `schema` or `bad_json`). It prints ids and hashes only, never event data. Exit code: 0 if all
chains are intact, 1 if any is broken, 2 for a usage or I/O error. After `pnpm -r build` the same check is available
as `node packages/core/dist/verify-cli.js`.

Limits: an edited, reordered or deleted middle event is detected. Removing a call's trailing events, or a whole call,
leaves a shorter chain that is still valid. To detect that, record the printed head hashes somewhere else and compare.
