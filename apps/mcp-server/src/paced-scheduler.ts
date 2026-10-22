/**
 * Variable-speed real-time scheduler for live sim calls.
 *
 * Sim time advances at `rate` sim-ms per real ms; the rate can change at any
 * moment (fast while on hold so "38:12 on hold" passes in seconds, near real
 * time while people talk or while the Echo is ringing). Satisfies both the
 * fake business's SimScheduler and call-agent's SessionTimers, so the
 * business, the call session and the clock share one sim timeline.
 */
import type { SimScheduler, TimerHandle } from '@standin/fake-business';

interface PacedTimer {
  id: number;
  dueAt: number;
  fn: () => void;
}

export class PacedScheduler implements SimScheduler {
  #rate: number;
  #simAnchor = 0;
  #realAnchor: number;
  #seq = 0;
  #timers: PacedTimer[] = [];
  #handle: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  readonly #realNow: () => number;

  constructor(opts: { rate?: number; realNow?: () => number } = {}) {
    this.#realNow = opts.realNow ?? (() => performance.now());
    this.#realAnchor = this.#realNow();
    this.#rate = PacedScheduler.#checkRate(opts.rate ?? 1);
  }

  static #checkRate(r: number): number {
    if (!Number.isFinite(r) || r <= 0) throw new RangeError('PacedScheduler: rate must be > 0');
    return r;
  }

  get rate(): number {
    return this.#rate;
  }

  /** Sim ms since the scheduler was created. */
  now(): number {
    return this.#simAnchor + (this.#realNow() - this.#realAnchor) * this.#rate;
  }

  setRate(rate: number): void {
    const r = PacedScheduler.#checkRate(rate);
    if (r === this.#rate) return;
    this.#simAnchor = this.now();
    this.#realAnchor = this.#realNow();
    this.#rate = r;
    this.#arm();
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = ++this.#seq;
    if (this.#stopped) return id;
    const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
    this.#timers.push({ id, dueAt: this.now() + delay, fn });
    this.#timers.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
    this.#arm();
    return id;
  }

  clearTimer(handle: TimerHandle): void {
    const before = this.#timers.length;
    this.#timers = this.#timers.filter((t) => t.id !== handle);
    if (this.#timers.length !== before) this.#arm();
  }

  pending(): number {
    return this.#timers.length;
  }

  /** Drops every timer; later setTimer calls are ignored. */
  stop(): void {
    this.#stopped = true;
    this.#timers = [];
    if (this.#handle !== undefined) clearTimeout(this.#handle);
    this.#handle = undefined;
  }

  #arm(): void {
    if (this.#handle !== undefined) clearTimeout(this.#handle);
    this.#handle = undefined;
    const head = this.#timers[0];
    if (head === undefined || this.#stopped) return;
    const realDelay = Math.max(0, (head.dueAt - this.now()) / this.#rate);
    this.#handle = setTimeout(() => this.#fire(), Math.min(realDelay, 2 ** 31 - 1));
    this.#handle.unref?.();
  }

  #fire(): void {
    this.#handle = undefined;
    const head = this.#timers[0];
    if (head === undefined) return;
    if (head.dueAt > this.now() + 0.5) {
      this.#arm();
      return;
    }
    this.#timers.shift();
    // Sim time never runs behind a timer that has fired.
    if (this.now() < head.dueAt) {
      this.#simAnchor = head.dueAt;
      this.#realAnchor = this.#realNow();
    }
    try {
      head.fn();
    } catch {
      // A timer callback must never take the server down; the session records its own errors.
    }
    this.#arm();
  }
}
