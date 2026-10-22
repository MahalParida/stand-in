/**
 * BharatNet IVR tree (spec section 6). The tree lives in ivr.json and is
 * validated with zod at load time, including that every `next` / option
 * target names an existing node.
 */
import { z } from 'zod';
import rawIvr from './ivr.json' with { type: 'json' };

const NodeIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'node id must be snake_case');
const DigitSchema = z.string().regex(/^[0-9*#]$/, 'option key must be a single DTMF digit');

export const IvrNodeSchema = z.discriminatedUnion('type', [
  /** Spoken once, then the IVR moves on to `next`. */
  z.object({ type: z.literal('message'), prompt: z.string().min(1).max(1000), next: NodeIdSchema }),
  /** Waits for a digit; repeats on no-input; unknown digits get `invalidPrompt`. */
  z.object({
    type: z.literal('menu'),
    prompt: z.string().min(1).max(1000),
    options: z.record(DigitSchema, NodeIdSchema),
  }),
  /** Caller is placed in the queue: hold music, then a human picks up. */
  z.object({ type: z.literal('queue'), prompt: z.string().min(1).max(1000) }),
]);
export type IvrNode = z.infer<typeof IvrNodeSchema>;

export const IvrVariantNameSchema = z.enum(['standard', 'loop']);
export type IvrVariantName = z.infer<typeof IvrVariantNameSchema>;

export const IvrVariantSchema = z
  .object({
    start: NodeIdSchema,
    invalidPrompt: z.string().min(1).max(500),
    noInputGoodbye: z.string().min(1).max(500),
    nodes: z.record(NodeIdSchema, IvrNodeSchema),
  })
  .superRefine((v, ctx) => {
    const has = (id: string): boolean => Object.prototype.hasOwnProperty.call(v.nodes, id);
    if (!has(v.start)) ctx.addIssue({ code: 'custom', path: ['start'], message: `unknown start node ${v.start}` });
    for (const [id, node] of Object.entries(v.nodes)) {
      const targets = node.type === 'message' ? [node.next] : node.type === 'menu' ? Object.values(node.options) : [];
      for (const t of targets) {
        if (!has(t)) ctx.addIssue({ code: 'custom', path: ['nodes', id], message: `node ${id} points at unknown node ${t}` });
      }
    }
  });
export type IvrVariant = z.infer<typeof IvrVariantSchema>;

export const IvrFileSchema = z.object({
  version: z.literal(1),
  business: z.string().min(1),
  variants: z.object({ standard: IvrVariantSchema, loop: IvrVariantSchema }),
});
export type IvrFile = z.infer<typeof IvrFileSchema>;

/** The validated contents of ivr.json. */
export const IVR: IvrFile = IvrFileSchema.parse(rawIvr);

export function ivrVariant(name: IvrVariantName): IvrVariant {
  return IVR.variants[name];
}

export function ivrNode(variant: IvrVariant, id: string): IvrNode {
  const node = Object.prototype.hasOwnProperty.call(variant.nodes, id) ? variant.nodes[id] : undefined;
  if (node === undefined) throw new Error(`IVR: unknown node ${id}`);
  return node;
}
