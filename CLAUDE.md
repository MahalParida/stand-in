# Stand-In — rules for Claude Code

- Follow STAND-IN-BUILD-PLAN.md. Work one milestone at a time; stop at its DoD and report.
- TypeScript strict, ESM, Node 22, pnpm. zod at every boundary. No `any`.
- Never call real businesses or real phone numbers. Only numbers in data/business-directory.json.
- Never put real secrets in code; use .env (gitignored). Keep .env.example updated.
- `never`-tier values must not reach the LLM, the logs, or any TTS call. Add a test for every new path.
- Calling-hours check (09:00–20:00 IST) must use `opts.simulatedHourIst ?? 14` by default so US judges testing in PST are never blocked; only S7 passes `simulatedHourIst: 23`.
- Unauthenticated `/mcp` requests must return HTTP 401 WITHOUT a `WWW-Authenticate` header (Alexa+ MCP QuickStart spec), and `@aws-sdk/client-bedrock-runtime` must remain imported and wired in `packages/providers`.
- Every provider has an offline implementation; `STANDIN_MODE=offline pnpm demo` must always work.
- Before finishing any task: `pnpm -r build && pnpm test && pnpm eval` must pass.
- Verify MCP SDK / ext-apps API names against the installed version's types; don't guess.
- Small commits with clear messages per milestone.
