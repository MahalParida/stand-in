/**
 * Provider configuration (spec 2.1). Parsed with zod from a plain env record
 * (normally `process.env`). Offline mode needs no AWS variables at all.
 *
 * Error messages name the offending variable, never its value.
 */
import { VoiceId } from '@aws-sdk/client-polly';
import { z } from 'zod';

/** `KEY=` in a .env file arrives as '' — treat it as unset. */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().min(1).optional(),
);

const withDefault = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

export const StandinModeSchema = z.enum(['offline', 'aws']);
export type StandinMode = z.infer<typeof StandinModeSchema>;

/** Offline LLM choice. In aws mode the LLM is always Bedrock (OpenAI is never used there). */
export const OfflineLlmSchema = z.enum(['scripted', 'openai']);
export type OfflineLlm = z.infer<typeof OfflineLlmSchema>;

export const RepoKindSchema = z.enum(['sqlite', 'dynamo']);
export type RepoKind = z.infer<typeof RepoKindSchema>;

export const PollyVoiceSchema = z.enum(VoiceId);

/** Follow-up scheduler. EventBridge is used only when STANDIN_MODE=aws as well. */
export const SchedulerKindSchema = z.enum(['local', 'eventbridge']);
export type SchedulerKind = z.infer<typeof SchedulerKindSchema>;

export const ProvidersEnvSchema = z
  .object({
    STANDIN_MODE: withDefault(StandinModeSchema.default('offline')),
    STANDIN_LLM: withDefault(OfflineLlmSchema.default('scripted')),
    /** Storage backend. DynamoDB is an M6 stretch, so sqlite is the default in both modes. */
    STANDIN_REPO: withDefault(RepoKindSchema.default('sqlite')),
    SQLITE_PATH: withDefault(z.string().min(1).default(':memory:')),

    /** Optional real LLM for local demo/eval (STANDIN_LLM=openai). Never used in aws mode. */
    OPENAI_API_KEY: optionalString,
    OPENAI_MODEL: optionalString,
    OPENAI_BASE_URL: withDefault(z.url().default('https://api.openai.com/v1')),
    /** 'off' for non-reasoning models; otherwise sent as reasoning_effort. */
    OPENAI_REASONING_EFFORT: withDefault(z.enum(['off', 'minimal', 'low', 'medium', 'high']).default('off')),
    OPENAI_TIMEOUT_MS: withDefault(z.coerce.number().int().positive().default(60_000)),

    AWS_REGION: optionalString,
    BEDROCK_MODEL_ID: optionalString,
    BEDROCK_TIMEOUT_MS: withDefault(z.coerce.number().int().positive().default(30_000)),
    DYNAMODB_TABLE: withDefault(z.string().min(1).default('standin')),
    POLLY_VOICE: withDefault(PollyVoiceSchema.default('Kajal')),
    POLLY_VOICE_IVR: withDefault(PollyVoiceSchema.default('Amy')),
    POLLY_VOICE_AGENT: withDefault(PollyVoiceSchema.default('Brian')),

    /** local = SQLite jobs + in-process ticker (default in every mode); eventbridge = aws mode only. */
    SCHEDULER: withDefault(SchedulerKindSchema.default('local')),
    /** EventBridge Scheduler target (e.g. a Lambda that runs the follow-up) and the role it assumes. */
    SCHEDULER_TARGET_ARN: optionalString,
    SCHEDULER_ROLE_ARN: optionalString,
    SCHEDULER_GROUP_NAME: withDefault(z.string().regex(/^[0-9a-zA-Z-_.]{1,64}$/).default('default')),
  })
  .superRefine((env, ctx) => {
    if (env.STANDIN_MODE !== 'aws') {
      if (env.STANDIN_LLM === 'openai') {
        for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL'] as const) {
          if (env[key] === undefined) {
            ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STANDIN_LLM=openai` });
          }
        }
      }
      return;
    }
    if (env.SCHEDULER === 'eventbridge') {
      for (const key of ['SCHEDULER_TARGET_ARN', 'SCHEDULER_ROLE_ARN'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when SCHEDULER=eventbridge` });
        }
      }
    }
    if (env.AWS_REGION === undefined) {
      ctx.addIssue({ code: 'custom', path: ['AWS_REGION'], message: 'AWS_REGION is required when STANDIN_MODE=aws' });
    }
    if (env.BEDROCK_MODEL_ID === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['BEDROCK_MODEL_ID'],
        message: 'BEDROCK_MODEL_ID is required when STANDIN_MODE=aws',
      });
    }
  });
export type ProvidersEnv = z.infer<typeof ProvidersEnvSchema>;

export class ProvidersConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`invalid provider configuration: ${variables.join(', ')}`);
    this.name = 'ProvidersConfigError';
  }
}

/** Validates the env. Throws ProvidersConfigError listing bad variable names (never values). */
export function parseProvidersEnv(env: Record<string, string | undefined>): ProvidersEnv {
  const r = ProvidersEnvSchema.safeParse(env);
  if (r.success) return r.data;
  const names = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '(root)')))];
  throw new ProvidersConfigError(names);
}
