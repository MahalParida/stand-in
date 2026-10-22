/**
 * The MCP Apps call card's error states (spec S5 "user told honestly"): runs
 * the card's own script in a vm with a minimal DOM and feeds it tool results
 * the way a host does (ui/notifications/tool-result).
 */
import { runInNewContext } from 'node:vm';
import { failureCopy, FailureReasonSchema, type FailureReason } from '@standin/core';
import { describe, expect, it } from 'vitest';
import { CALL_CARD_HTML } from './card.js';

class FakeEl {
  children: FakeEl[] = [];
  className = '';
  hidden = false;
  title = '';
  type = '';
  value = '';
  placeholder = '';
  disabled = false;
  checked = false;
  onclick: (() => void) | null = null;
  #text = '';
  constructor(readonly tag: string) {}
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeEl): void {
    this.children = this.children.filter((x) => x !== c);
  }
  setAttribute(): void {}
  set textContent(v: string) {
    this.#text = v;
    this.children = [];
  }
  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join(' ');
  }
}

function loadCard() {
  const script = /<script>([\s\S]*)<\/script>/.exec(CALL_CARD_HTML)?.[1];
  if (script === undefined) throw new Error('no script');
  const ids: Record<string, FakeEl> = { biz: new FakeEl('div'), badge: new FakeEl('div'), steps: new FakeEl('div'), body: new FakeEl('div'), err: new FakeEl('div') };
  const listeners: ((ev: { source: unknown; data: unknown }) => void)[] = [];
  const parent = { postMessage: () => undefined };
  const document = {
    createElement: (t: string) => new FakeEl(t),
    createTextNode: (t: string) => {
      const e = new FakeEl('#text');
      e.textContent = t;
      return e;
    },
    getElementById: (id: string) => ids[id],
    documentElement: { scrollHeight: 100, setAttribute: () => undefined, style: { setProperty: () => undefined } },
  };
  const window = { parent, addEventListener: (_t: string, cb: (ev: { source: unknown; data: unknown }) => void) => listeners.push(cb) };
  runInNewContext(script, { window, document, setTimeout: () => 0, setInterval: () => 0, clearInterval: () => undefined, JSON, Math, Object, Array, String, Promise, Error });
  const toolResult = (params: unknown): void => {
    for (const l of listeners) l({ source: parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params } });
  };
  return { ids, toolResult };
}

const errorResult = (code: string, message: string) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] });

describe('call card error states', () => {
  it.each(['outside_calling_hours', 'not_allowlisted', 'daily_cap_reached', 'call_setup_failed'] as const)(
    'a refused place_call (%s) renders a "Not called" card with the specific headline and the honest message',
    (code) => {
      const card = loadCard();
      const message = failureCopy(code, { businessName: 'BharatNet Broadband' }).message;
      card.toolResult(errorResult(code, message));
      expect(card.ids.badge?.textContent).toBe('Not called');
      expect(card.ids.badge?.className).toContain('failed');
      const body = card.ids.body?.textContent ?? '';
      expect(body).toContain(failureCopy(code).headline);
      expect(body).toContain(message);
      expect(card.ids.err?.hidden).toBe(true);
    },
  );

  it('a refusal after an earlier call replaces that call on the card', () => {
    const card = loadCard();
    card.toolResult({ structuredContent: { callId: 'call-1', caseId: 'c', state: 'ENDED', holdSeconds: 0, lastLines: [], digitsPressed: [], blockedCount: 0, injectionCount: 0, summary: 'Done.' } });
    expect(card.ids.badge?.textContent).toBe('Done');
    card.toolResult(errorResult('daily_cap_reached', failureCopy('daily_cap_reached').message));
    expect(card.ids.badge?.textContent).toBe('Not called');
    expect(card.ids.body?.textContent).toContain('Daily call limit reached');
  });

  it('unknown_business reads as not in the directory', () => {
    const card = loadCard();
    card.toolResult(errorResult('unknown_business', 'nope'));
    expect(card.ids.body?.textContent).toContain(failureCopy('not_allowlisted').headline);
  });

  it.each(['ivr_dead_end', 'server_restart', 'carrier_error'] as FailureReason[])('a FAILED call (%s) shows its own headline and the summary', (reason) => {
    expect(FailureReasonSchema.options).toContain(reason);
    const card = loadCard();
    const summary = failureCopy(reason, { businessName: 'BharatNet Broadband' }).message;
    card.toolResult({
      structuredContent: {
        callId: 'call-1',
        caseId: 'case-1',
        state: 'FAILED',
        holdSeconds: 0,
        lastLines: [],
        digitsPressed: [],
        blockedCount: 0,
        injectionCount: 0,
        failureReason: reason,
        summary,
      },
    });
    expect(card.ids.badge?.textContent).toBe('Failed');
    const body = card.ids.body?.textContent ?? '';
    expect(body).toContain(failureCopy(reason).headline);
    expect(body).toContain(summary);
  });

  it('other tool errors stay a small error line', () => {
    const card = loadCard();
    card.toolResult(errorResult('case_not_ready', 'A call for this case is already in progress.'));
    expect(card.ids.err?.hidden).toBe(false);
    expect(card.ids.err?.textContent).toContain('already in progress');
    expect(card.ids.badge?.textContent).toBe('Preparing');
  });
});
