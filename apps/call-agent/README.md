# @standin/call-agent

The call runtime (spec section 5): `CallSession` drives core's pure state machine over a `Carrier`. The planner decides the words, code decides the actions, and the disclosure guard sits between the planner and the line.

## Pieces

| Export | What it does |
|---|---|
| `CallService` | `placeCall(caseId, { simulatedHourIst? })` checks core `canPlaceCallWithRepo` (the hour defaults to 14) and the directory allowlist *before* any carrier exists. On a refusal it returns `{ ok:false, code, message }` and dials nothing. On success it returns `{ ok, callId, state:'DIALING', session, finished }`. `finished` persists the call, adds the promise to the case and schedules a follow-up job for `dueBy + 1 day`. `runFollowup(job)` places the S6 call that quotes the ticket. |
| `CallSession` | `start()`, `snapshot()` → `{state, holdSeconds, lastLines, pendingQuestion?, outcome?, failureReason?, failureMessage?}`, `acceptHandoff()`, `declineHandoff()`, `userLeave()`, `answerPending(text, questionId?)`, `end()`, `events()`, `verify()`, `idle()`, `done`, `onChange(cb)`, `onFactAdded(cb)` |
| `SimCarrier` | A core `Carrier` linked in-process to a `FakeBusiness` through an EventEmitter. It refuses non-allowlisted numbers, and `userSay()` carries the bridged user's own voice. |
| `ScriptedPlanner` / `scriptedPolicy` | A deterministic policy with no LLM. It is the default for eval and offline mode. |
| `LlmPlanner(llm)` | Works with any core `LlmProvider` (LocalLlm or Bedrock). Its output is parsed with core's `PlannerOutputSchema`. Invalid JSON, a schema failure or a provider error each produce a safe fallback plus an `error` event. |
| `createPolicyLlm()` / `GarbageInjectingLlm` | The scripted policy exposed through the real prompt → JSON → zod path, plus a garbage injector for S8. |

## Safety properties (tested)

- The planner sees facts only as `{key, label, tier, speakable}`. No fact value is ever sent, and the goal and transcript are masked first. A test captures every LLM request of a whole OTP-trap call and checks it contains no never-tier value.
- Every utterance passes through `guardUtterance` (expand plus DLP), followed by one final scan of the exact string sent to the carrier. A blocked utterance is replaced by the fallback and recorded as a `blocked_utterance` event.
- `said` and `heard` text is masked before it is logged. The user's own speech while bridged never reaches the session.
- Callee speech is classified before planning:
  - A never-tier request leads to `HANDOFF_PENDING` with a hand-off `pendingQuestion`.
  - An instruction injection is logged and refused, and the user's phone does not ring.
  - A request for an unknown fact (or a planner `{{fact:x}}` for a key the case lacks) produces a question `pendingQuestion`, which `answerPending` resolves. The tier of the answer is assigned by the guard.
- The opening line is always "Hi, I'm an AI assistant calling on behalf of {name}. This call is being transcribed for them."
- Max 3 IVR loops leads to `FAILED(ivr_dead_end)`. Max duration and the 60 s hand-off timeout run on an injectable `Clock` plus `SessionTimers`; a `VirtualScheduler` from fake-business satisfies the timers, so eval runs on sim time.
