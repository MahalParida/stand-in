export const PACKAGE_NAME = '@standin/fake-business' as const;

export {
  FakeBusiness,
  AgentActionSchema,
  HOLD_ANNOUNCEMENT,
  HANGUP_TEXT,
  type AgentAction,
  type BusinessEvent,
  type BusinessEventBody,
  type BusinessPhase,
  type BusinessReport,
  type EndReason,
  type FakeBusinessOptions,
  type HoldReason,
  type TimedFrame,
  type TranscriptLine,
} from './business.js';
export { connect, createSimLine, type BusinessLine, type SimLine } from './connect.js';
export {
  FakeBusinessScenarioSchema,
  AdversarialSchema,
  FactAskSchema,
  FollowupSchema,
  ScenarioOutcomeSchema,
  TicketIdSchema,
  TimingSchema,
  SCENARIO_PRESETS,
  DEFAULT_SIM_EPOCH_MS,
  formatIstDate,
  resolveDueBy,
  parseScenario,
  presetScenario,
  type Adversarial,
  type FactAsk,
  type FakeBusinessScenario,
  type FakeBusinessScenarioInput,
  type Followup,
  type ScenarioOutcome,
  type ScenarioPresetName,
  type Timing,
} from './scenario.js';
export {
  VirtualScheduler,
  RealtimeScheduler,
  type SimScheduler,
  type TimerHandle,
  type RunUntilIdleOptions,
  type RunUntilIdleResult,
} from './scheduler.js';
export {
  ScriptedRavi,
  SECRET_LINES,
  USER_VERIFY_LINE,
  NO_RECORD_LINE,
  TRANSFER_LINE,
  CLOSING_LINE,
  NUDGE_LINE,
  NO_RESPONSE_LINE,
  outcomeLine,
  type RaviInput,
  type RaviNote,
  type RaviPersona,
  type RaviStep,
  type RaviTurn,
  type RaviExpect,
  type SecretVariant,
  type SecretAskResult,
  type FactResult,
} from './ravi.js';
export { LlmRavi, LlmRaviLineSchema, type LlmRaviOptions } from './llm-ravi.js';
export { IVR, IvrFileSchema, IvrNodeSchema, IvrVariantSchema, IvrVariantNameSchema, ivrNode, ivrVariant, type IvrFile, type IvrNode, type IvrVariant, type IvrVariantName } from './ivr.js';
export { SeededRng } from './rng.js';
export { containsValue, detectIntents, digitRuns, maskSecrets, mentionsTicket, spokenDigitsToNumerals } from './intents.js';
