/**
 * Injectable sim-time scheduler. The fake business never touches wall-clock
 * timers directly, so `pnpm eval` can run a 38-minute hold instantly and
 * deterministically (VirtualScheduler) while the demo can run in compressed
 * real time (RealtimeScheduler).
 */

export type TimerHandle = number;

export interface SimScheduler {
  /** Current sim time in ms (monotonic, starts at 0 for the virtual scheduler). */
  now(): number;
  setTimer(fn: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

interface VirtualTimer {
  id: number;
  dueAt: number;
  fn: () => void;
}

export interface RunUntilIdleOptions {
  /** Stop after this many timers fired (default 100 000). */
  maxSteps?: number;
  /** Stop before firing a timer due later than now() + maxSimMs. */
  maxSimMs?: number;
  /**
   * Awaited before every timer fires so async work (an awaiting call agent, an
   * LLM persona) can react first. Defaults to a macrotask turn.
   */
  settle?: () => Promise<unknown>;
  /** Return true to stop early (checked after every settle). */
  until?: () => boolean;
}

export interface RunUntilIdleResult {
  steps: number;
  simMs: number;
  /** Why the loop stopped. */
  stoppedBy: 'idle' | 'until' | 'max_steps' | 'max_sim_ms';
}

const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Deterministic discrete-event scheduler: timers fire in (dueAt, creation order). */
export class VirtualScheduler implements SimScheduler {
  #now = 0;
  #seq = 0;
  #timers: VirtualTimer[] = [];

  now(): number {
    return this.#now;
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const delay = Number.isFinite(delayMs) && delayMs > 0 ? Math.round(delayMs) : 0;
    const id = ++this.#seq;
    this.#timers.push({ id, dueAt: this.#now + delay, fn });
    this.#timers.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
    return id;
  }

  clearTimer(handle: TimerHandle): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  /** Number of timers waiting to fire. */
  pending(): number {
    return this.#timers.length;
  }

  /** Sim time of the next timer, if any. */
  nextDueAt(): number | undefined {
    return this.#timers[0]?.dueAt;
  }

  /** Fire the next timer (advancing time to it). Returns false when nothing is pending. */
  runNext(): boolean {
    const t = this.#timers.shift();
    if (t === undefined) return false;
    this.#now = Math.max(this.#now, t.dueAt);
    t.fn();
    return true;
  }

  /** Fire every timer due within `ms`, then set the clock to now + ms. */
  advance(ms: number): void {
    const target = this.#now + Math.max(0, ms);
    for (;;) {
      const next = this.#timers[0];
      if (next === undefined || next.dueAt > target) break;
      this.runNext();
    }
    this.#now = target;
  }

  /**
   * Alternate "let async work settle" and "fire the next timer" until no timer
   * is left (or a limit is hit). This is how eval drives a whole call.
   */
  async runUntilIdle(opts: RunUntilIdleOptions = {}): Promise<RunUntilIdleResult> {
    const maxSteps = opts.maxSteps ?? 100_000;
    const settle = opts.settle ?? macrotask;
    const start = this.#now;
    const limit = opts.maxSimMs === undefined ? Number.POSITIVE_INFINITY : start + opts.maxSimMs;
    let steps = 0;
    for (;;) {
      await settle();
      await macrotask();
      if (opts.until?.()) return { steps, simMs: this.#now - start, stoppedBy: 'until' };
      const due = this.nextDueAt();
      if (due === undefined) return { steps, simMs: this.#now - start, stoppedBy: 'idle' };
      if (due > limit) return { steps, simMs: this.#now - start, stoppedBy: 'max_sim_ms' };
      if (steps >= maxSteps) return { steps, simMs: this.#now - start, stoppedBy: 'max_steps' };
      this.runNext();
      steps++;
    }
  }
}

/**
 * Wall-clock scheduler with optional time compression: `speedup: 20` plays a
 * 120 s sim hold in 6 s real time while `now()` still reports sim ms.
 */
export class RealtimeScheduler implements SimScheduler {
  readonly #speedup: number;
  readonly #startReal: number;
  #seq = 0;
  readonly #handles = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(opts: { speedup?: number } = {}) {
    const s = opts.speedup ?? 1;
    if (!Number.isFinite(s) || s <= 0) throw new RangeError('RealtimeScheduler: speedup must be > 0');
    this.#speedup = s;
    this.#startReal = Date.now();
  }

  now(): number {
    return Math.round((Date.now() - this.#startReal) * this.#speedup);
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = ++this.#seq;
    const h = setTimeout(() => {
      this.#handles.delete(id);
      fn();
    }, Math.max(0, delayMs) / this.#speedup);
    this.#handles.set(id, h);
    return id;
  }

  clearTimer(handle: TimerHandle): void {
    const h = this.#handles.get(handle);
    if (h !== undefined) clearTimeout(h);
    this.#handles.delete(handle);
  }
}
