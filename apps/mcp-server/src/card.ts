/**
 * ui://standin/call-card — the MCP Apps call card (spec 7), served as
 * `text/html;profile=mcp-app`. Self-contained HTML/CSS/JS, no network access.
 *
 * Talks to the host with the MCP Apps postMessage JSON-RPC protocol as
 * defined by @modelcontextprotocol/ext-apps 2.0.3 (spec.types.d.ts):
 *   view -> host: ui/initialize (protocolVersion 2026-01-26), then
 *                 ui/notifications/initialized; tools/call for buttons and
 *                 polling; ui/notifications/size-changed.
 *   host -> view: ui/notifications/tool-input, ui/notifications/tool-result,
 *                 ui/notifications/host-context-changed (theme, styles),
 *                 ui/resource-teardown.
 *
 * Every text it shows comes from tool results that are already masked by the
 * server; it is inserted with textContent, never as HTML.
 */

export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26' as const;

export const CALL_CARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stand-In call</title>
<style>
:root {
  --bg: #ffffff; --fg: #14171f; --muted: #5d6475; --line: #e3e6ee; --card: #f6f7fb;
  --accent: #1f6feb; --ok: #1a7f37; --warn: #b54708; --bad: #c62828; --chip: #eef2ff;
  --radius: 14px; --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #12151c; --fg: #eef1f7; --muted: #9aa3b5; --line: #262b36; --card: #1a1e27;
    --accent: #58a6ff; --ok: #3fb950; --warn: #f0883e; --bad: #ff7b72; --chip: #1f2a44; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #12151c; --fg: #eef1f7; --muted: #9aa3b5; --line: #262b36; --card: #1a1e27;
  --accent: #58a6ff; --ok: #3fb950; --warn: #f0883e; --bad: #ff7b72; --chip: #1f2a44; color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font); }
.card { padding: 16px 18px; border-radius: var(--radius); background: var(--bg); max-width: 560px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.biz { font-weight: 650; font-size: 15px; }
.badge { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--chip); color: var(--accent); white-space: nowrap; }
.badge.needs { background: var(--warn); color: #fff; animation: pulse 1.2s ease-in-out infinite; }
.badge.done { background: var(--ok); color: #fff; }
.badge.failed { background: var(--bad); color: #fff; }
@keyframes pulse { 50% { opacity: .6; } }
.steps { display: flex; gap: 4px; margin: 12px 0 14px; }
.steps span { flex: 1; height: 4px; border-radius: 2px; background: var(--line); }
.steps span.on { background: var(--accent); }
.title { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 14px; margin: 0 0 10px; line-height: 1.4; }
.timer { font-size: 48px; font-weight: 750; letter-spacing: 1px; font-variant-numeric: tabular-nums; margin: 6px 0 4px; }
.digits { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
.digit { min-width: 30px; text-align: center; padding: 4px 8px; border-radius: 8px; background: var(--chip); color: var(--accent); font-weight: 700; }
.lines { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.lines li { font-size: 13.5px; line-height: 1.35; padding: 7px 10px; border-radius: 10px; background: var(--card); }
.lines li .who { font-weight: 650; margin-right: 6px; color: var(--muted); }
.lines li.standin .who { color: var(--accent); }
.facts { list-style: none; padding: 0; margin: 8px 0 0; font-size: 13.5px; }
.facts li { padding: 3px 0; color: var(--muted); }
.row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
button { font: inherit; font-weight: 650; font-size: 14px; border: 0; border-radius: 10px; padding: 9px 16px; cursor: pointer; background: var(--accent); color: #fff; }
button.secondary { background: var(--card); color: var(--fg); border: 1px solid var(--line); }
button:disabled { opacity: .5; cursor: default; }
input[type=text] { font: inherit; flex: 1; min-width: 140px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
label.approve { font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 14px; margin-top: 6px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; font-weight: 600; }
.ok { color: var(--ok); font-weight: 650; }
.err { color: var(--bad); font-size: 13px; margin-top: 8px; }
.meta { color: var(--muted); font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<div class="card" id="root" aria-live="polite">
  <div class="head"><div class="biz" id="biz">Stand-In</div><div class="badge" id="badge">Preparing</div></div>
  <div class="steps" id="steps"></div>
  <div id="body"><p class="title">Preparing</p><p class="sub">Waiting for the case…</p></div>
  <div class="err" id="err" hidden></div>
</div>
<script>
(function () {
  'use strict';
  var STAGES = ['Preparing', 'Dialing', 'Menu', 'On hold', 'Talking', 'Needs you', 'Done'];
  var TERMINAL = { ENDED: true, FAILED: true };
  var st = { caseView: null, missing: [], callId: null, status: null, timer: null, busy: false, error: '' };
  var seq = 1, waiting = {};

  function post(msg) { try { window.parent.postMessage(msg, '*'); } catch (e) { /* standalone */ } }
  function request(method, params) {
    var id = seq++;
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
      setTimeout(function () { if (waiting[id]) { delete waiting[id]; reject(new Error('timeout')); } }, 20000);
    });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function applyContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    if (ctx.theme === 'light' || ctx.theme === 'dark') document.documentElement.setAttribute('data-theme', ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach(function (k) {
        if (/^--[a-zA-Z0-9-]+$/.test(k) && typeof vars[k] === 'string') document.documentElement.style.setProperty(k, vars[k]);
      });
    }
  }

  function callTool(name, args) {
    return request('tools/call', { name: name, arguments: args }).then(function (res) { onResult(res, name); return res; });
  }

  function onResult(res, toolName) {
    if (!res || typeof res !== 'object') return;
    var sc = res.structuredContent;
    if (res.isError) {
      st.error = sc && sc.error && sc.error.message ? sc.error.message : 'Something went wrong.';
      render();
      return;
    }
    st.error = '';
    if (!sc || typeof sc !== 'object') return;
    if (sc.case && typeof sc.case === 'object') {
      st.caseView = sc.case;
      if (Array.isArray(sc.missingFacts)) st.missing = sc.missingFacts;
    }
    if (typeof sc.callId === 'string') {
      if (st.callId !== sc.callId) { st.callId = sc.callId; st.status = null; }
      if (Array.isArray(sc.lastLines)) st.status = sc;
      else if (sc.state && st.status) st.status.state = sc.state;
      else if (sc.state) st.status = { state: sc.state, lastLines: [], digitsPressed: [], holdSeconds: 0, summary: '' };
      ensurePolling();
    }
    render();
  }

  function ensurePolling() {
    if (st.timer || !st.callId) return;
    st.timer = setInterval(function () {
      if (!st.callId) return;
      if (st.status && TERMINAL[st.status.state]) { clearInterval(st.timer); st.timer = null; return; }
      callTool('call_status', { callId: st.callId }).catch(function () { /* keep polling */ });
    }, 1000);
  }

  function stage() {
    var s = st.status;
    if (!st.callId || !s) return 0;
    if (TERMINAL[s.state]) return 6;
    if (s.state === 'HANDOFF_PENDING' || s.pendingQuestion) return 5;
    if (s.state === 'DIALING') return 1;
    if (s.state === 'IVR') return 2;
    if (s.state === 'HOLD') return 3;
    return 4;
  }

  function fmtTimer(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  var WHO = { standin: 'Stand-In', ivr: 'Menu', agent: 'Agent', user: 'You', system: '' };

  function act(name, args) {
    if (st.busy) return;
    st.busy = true; render();
    callTool(name, args).catch(function () { st.error = 'The host could not run ' + name + '.'; })
      .then(function () { st.busy = false; render(); });
  }

  function render() {
    var stg = stage();
    var s = st.status;
    var biz = (st.caseView && st.caseView.businessName) || 'Stand-In';
    document.getElementById('biz').textContent = biz;
    var badge = document.getElementById('badge');
    badge.textContent = s && s.state === 'FAILED' ? 'Failed' : STAGES[stg];
    badge.className = 'badge' + (stg === 5 ? ' needs' : stg === 6 ? (s && s.state === 'FAILED' ? ' failed' : ' done') : '');
    var steps = document.getElementById('steps');
    clear(steps);
    for (var i = 0; i < STAGES.length; i++) { var b = el('span', i <= stg ? 'on' : ''); b.title = STAGES[i]; steps.appendChild(b); }

    var body = document.getElementById('body');
    clear(body);
    if (stg === 0) {
      body.appendChild(el('p', 'title', 'Preparing'));
      if (st.caseView) {
        body.appendChild(el('p', 'sub', st.caseView.goal));
        if (st.missing.length) {
          body.appendChild(el('p', 'sub', 'Still needed before calling:'));
          var ul = el('ul', 'facts');
          st.missing.forEach(function (m) { ul.appendChild(el('li', '', '• ' + m.label)); });
          body.appendChild(ul);
        } else {
          body.appendChild(el('p', 'ok', 'Case ready ✓'));
        }
      } else {
        body.appendChild(el('p', 'sub', 'Waiting for the case…'));
      }
    } else if (stg === 1) {
      body.appendChild(el('p', 'title', 'Dialing'));
      body.appendChild(el('p', 'sub', s.summary || ('Calling ' + biz + '…')));
    } else if (stg === 2) {
      body.appendChild(el('p', 'title', 'Phone menu'));
      body.appendChild(el('p', 'sub', s.summary || 'Navigating the menu…'));
      var d = el('div', 'digits');
      (s.digitsPressed || []).forEach(function (x) { d.appendChild(el('span', 'digit', x)); });
      body.appendChild(d);
    } else if (stg === 3) {
      body.appendChild(el('p', 'title', 'On hold'));
      body.appendChild(el('div', 'timer', fmtTimer(s.holdSeconds)));
      body.appendChild(el('p', 'sub', 'Stand-In is waiting so you don’t have to.'));
    } else if (stg === 4 || stg === 5) {
      body.appendChild(el('p', 'title', stg === 5 ? 'Needs you' : (s.state === 'USER_ON_LINE' ? 'You’re on the line' : 'Talking')));
      body.appendChild(el('p', 'sub', s.summary || ''));
      if (stg === 5) renderNeedsYou(body, s);
      var ul2 = el('ul', 'lines');
      (s.lastLines || []).slice(-4).forEach(function (l) {
        var li = el('li', l.speaker);
        if (WHO[l.speaker]) li.appendChild(el('span', 'who', WHO[l.speaker]));
        li.appendChild(document.createTextNode(l.text));
        ul2.appendChild(li);
      });
      body.appendChild(ul2);
      var row = el('div', 'row');
      var end = el('button', 'secondary', 'End call');
      end.disabled = st.busy;
      end.onclick = function () { act('end_call', { callId: st.callId }); };
      row.appendChild(end);
      body.appendChild(row);
    } else {
      renderDone(body, s);
    }
    if (s && (s.blockedCount || s.injectionCount)) {
      body.appendChild(el('p', 'meta', 'Disclosure guard: ' + (s.blockedCount || 0) + ' blocked · ' + (s.injectionCount || 0) + ' injection attempt(s) ignored'));
    }
    var err = document.getElementById('err');
    err.hidden = !st.error;
    err.textContent = st.error || '';
    notify('ui/notifications/size-changed', { height: Math.ceil(document.documentElement.scrollHeight) });
  }

  function renderNeedsYou(body, s) {
    var p = s.pendingQuestion;
    if (s.state === 'HANDOFF_PENDING' || (p && p.kind === 'handoff')) {
      body.appendChild(el('p', 'sub', (p && p.label ? p.label + ': ' : '') + 'only you can answer this.'));
      var row = el('div', 'row');
      var join = el('button', '', 'Join call');
      join.disabled = st.busy;
      join.onclick = function () { act('handoff_to_user', { callId: st.callId, accept: true }); };
      var dec = el('button', 'secondary', 'Decline');
      dec.disabled = st.busy;
      dec.onclick = function () { act('handoff_to_user', { callId: st.callId, accept: false }); };
      row.appendChild(join); row.appendChild(dec);
      body.appendChild(row);
      return;
    }
    if (!p) return;
    var row2 = el('div', 'row');
    var input = el('input');
    input.type = 'text';
    input.placeholder = p.label;
    input.setAttribute('aria-label', p.label);
    var approveBox = null;
    if (p.kind === 'confirm') {
      var lab = el('label', 'approve');
      approveBox = el('input');
      approveBox.type = 'checkbox';
      lab.appendChild(approveBox);
      lab.appendChild(document.createTextNode('OK to share this personal detail'));
      body.appendChild(lab);
    }
    var send = el('button', '', 'Answer');
    send.disabled = st.busy;
    send.onclick = function () {
      var v = (input.value || '').trim();
      if (!v) return;
      var args = { callId: st.callId, answer: v };
      if (approveBox && approveBox.checked) args.approve = true;
      act('send_to_call', args);
    };
    row2.appendChild(input); row2.appendChild(send);
    body.appendChild(row2);
  }

  function renderDone(body, s) {
    if (s.state === 'FAILED') {
      body.appendChild(el('p', 'title', 'Call failed'));
      body.appendChild(el('p', 'sub', s.summary || 'The call did not complete.'));
      return;
    }
    body.appendChild(el('p', 'title', s.outcome ? 'Done ✓' : 'Call ended'));
    if (s.outcome) {
      var dl = el('dl', 'kv');
      dl.appendChild(el('dt', '', 'Promise')); dl.appendChild(el('dd', '', s.outcome.what));
      if (s.outcome.ticketId) { dl.appendChild(el('dt', '', 'Ticket')); dl.appendChild(el('dd', '', s.outcome.ticketId)); }
      if (s.outcome.dueBy) { dl.appendChild(el('dt', '', 'Due by')); dl.appendChild(el('dd', '', s.outcome.dueBy)); }
      if (s.outcome.agentName) { dl.appendChild(el('dt', '', 'Agent')); dl.appendChild(el('dd', '', s.outcome.agentName)); }
      body.appendChild(dl);
    } else {
      body.appendChild(el('p', 'sub', s.summary || ''));
    }
    if (s.followupScheduled) body.appendChild(el('p', 'ok', 'Follow-up scheduled ✓'));
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && m.method === undefined) {
      var w = waiting[m.id];
      if (w) { delete waiting[m.id]; if (m.error) w.reject(m.error); else w.resolve(m.result); }
      return;
    }
    switch (m.method) {
      case 'ui/notifications/tool-result': onResult(m.params, null); break;
      case 'ui/notifications/tool-input': break;
      case 'ui/notifications/host-context-changed': applyContext(m.params); break;
      case 'ui/resource-teardown':
        if (st.timer) { clearInterval(st.timer); st.timer = null; }
        if (m.id !== undefined) post({ jsonrpc: '2.0', id: m.id, result: {} });
        break;
      default:
        if (m.id !== undefined) post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
  });

  render();
  request('ui/initialize', {
    appInfo: { name: 'standin-call-card', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}'
  }).then(function (r) {
    if (r && r.hostContext) applyContext(r.hostContext);
    notify('ui/notifications/initialized', {});
  }).catch(function () { /* no host: static preview */ });
})();
</script>
</body>
</html>
`;
