/**
 * SimCarrier (spec 5.4): the default, in-process Carrier. An EventEmitter
 * links the call agent to a FakeBusiness ("BharatNet Broadband"); no network,
 * no phone bill. Frames from the business are validated (zod) at the boundary.
 */
import { EventEmitter } from 'node:events';
import { DtmfDigitsSchema, InboundFrameSchema, type Business, type Carrier, type InboundFrame } from '@standin/core';
import type { FakeBusiness } from '@standin/fake-business';
import { z } from 'zod';
import { NotAllowlistedError, isAllowlistedNumber } from './directory.js';

const SayTextSchema = z.string().min(1).max(10_000);

export interface SimCarrierOptions {
  /** If given, dial() refuses numbers outside it (defence in depth; the service checks first). */
  directory?: readonly Business[];
}

export class SimCarrier implements Carrier {
  readonly business: FakeBusiness;
  readonly #bus = new EventEmitter();
  readonly #directory: readonly Business[] | undefined;
  readonly #unsubscribe: () => void;
  /** Exactly what was handed to the line / TTS by the agent (already guarded). */
  readonly spoken: string[] = [];
  readonly digitsPressed: string[] = [];
  readonly dialed: string[] = [];
  #bridged = false;

  constructor(business: FakeBusiness, opts: SimCarrierOptions = {}) {
    this.business = business;
    this.#directory = opts.directory;
    this.#unsubscribe = business.on('frame', (f) => {
      const parsed = InboundFrameSchema.safeParse(f);
      if (parsed.success) this.#bus.emit('frame', parsed.data);
    });
  }

  get userBridged(): boolean {
    return this.#bridged;
  }

  async dial(number: string, opts: { callId: string }): Promise<void> {
    if (this.#directory !== undefined && !isAllowlistedNumber(number, this.#directory)) {
      throw new NotAllowlistedError();
    }
    this.dialed.push(number);
    await this.business.handle({ type: 'dial', number, callId: opts.callId });
  }

  async say(text: string, _audio?: Uint8Array): Promise<void> {
    const t = SayTextSchema.parse(text);
    this.spoken.push(t);
    await this.business.handle({ type: 'say', text: t });
  }

  async pressDigits(digits: string): Promise<void> {
    const d = DtmfDigitsSchema.parse(digits);
    this.digitsPressed.push(d);
    await this.business.handle({ type: 'dtmf', digits: d });
  }

  async bridgeUser(): Promise<void> {
    this.#bridged = true;
    await this.business.handle({ type: 'bridge_user' });
  }

  async unbridgeUser(): Promise<void> {
    this.#bridged = false;
    await this.business.handle({ type: 'unbridge_user' });
  }

  /**
   * The bridged user's own voice. It goes straight to the business and is
   * never seen by the call agent, its event log or any LLM.
   */
  async userSay(text: string): Promise<void> {
    if (!this.#bridged) return;
    await this.business.handle({ type: 'user_say', text: SayTextSchema.parse(text) });
  }

  async hangup(): Promise<void> {
    this.#bridged = false;
    await this.business.handle({ type: 'hangup' });
  }

  on(event: 'frame', cb: (f: InboundFrame) => void): void {
    this.#bus.on(event, cb);
  }

  /** Detach from the business (the business keeps running). */
  close(): void {
    this.#unsubscribe();
    this.#bus.removeAllListeners();
  }
}
