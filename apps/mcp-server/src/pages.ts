/**
 * Small self-contained HTML pages: the account-linking consent and error
 * pages, /privacy and /terms. No external resources, no scripts.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

const STYLE = `:root{--bg:#f6f8fb;--card:#fff;--fg:#14171f;--muted:#5b6372;--line:#dfe3ea;--brand:#155e75;--brand-fg:#fff;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#10141b;--card:#181d26;--fg:#eef1f7;--muted:#a3abba;--line:#2a313d;--brand:#38a3bd;--brand-fg:#0b1016;--danger:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:620px;margin:0 auto;padding:32px 16px 48px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:1.45rem;line-height:1.25;margin:0 0 12px}h2{font-size:1.05rem;margin:22px 0 6px}p,li{color:var(--fg)}.muted{color:var(--muted);font-size:.92rem}
.mark{display:inline-flex;align-items:center;gap:10px;font-weight:700;margin-bottom:16px;color:var(--brand)}
.mark span{display:inline-block;width:28px;height:28px;border-radius:8px;background:var(--brand)}
label{display:block;font-weight:600;margin:16px 0 6px}input[type=password]{width:100%;padding:10px 12px;font:inherit;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}button{font:inherit;font-weight:600;border-radius:10px;padding:10px 18px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg);min-height:44px}
button.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-fg)}.err{color:var(--danger);font-weight:600}
ul{padding-left:20px}a{color:var(--brand)}code{font-size:.9em}`;

export function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><div class="mark"><span aria-hidden="true"></span>Stand-In</div>${body}</main></body></html>`;
}

export interface ConsentPageInput {
  userName: string;
  pendingId: string;
  csrf: string;
  scope: string;
  needPasscode: boolean;
  error?: string;
}

export function consentPage(i: ConsentPageInput): string {
  const scopes = i.scope.split(' ').filter((s) => s.length > 0);
  return htmlPage(
    'Link Stand-In',
    `<div class="card"><h1>Link Stand-In to Alexa for ${escapeHtml(i.userName)}</h1>
<p>Alexa is asking to use Stand-In on your behalf: open support cases, place <strong>simulated</strong> calls to allowlisted demo businesses, and read the results back to you.</p>
<p class="muted">Access requested: ${scopes.map((s) => `<code>${escapeHtml(s)}</code>`).join(', ') || '<code>standin</code>'}. You can unlink at any time in the Alexa app.</p>
${i.error !== undefined ? `<p class="err" role="alert">${escapeHtml(i.error)}</p>` : ''}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="pending" value="${escapeHtml(i.pendingId)}"><input type="hidden" name="csrf" value="${escapeHtml(i.csrf)}">
${i.needPasscode ? '<label for="passcode">Demo passcode</label><input id="passcode" name="passcode" type="password" required autocomplete="off">' : ''}
<div class="row"><button class="primary" type="submit" name="action" value="approve">Approve</button><button type="submit" name="action" value="deny" formnovalidate>Deny</button></div>
</form></div>
<p class="muted">Stand-In is a hackathon demo. It never calls real businesses or real phone numbers. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`,
  );
}

export function errorPage(title: string, message: string): string {
  return htmlPage(
    title,
    `<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
<p class="muted">Start linking again from the Alexa app. If this keeps happening, the add-on's OAuth settings and this server's configuration do not match.</p></div>`,
  );
}

export interface LegalPageInput {
  ttlDays: number;
  contact: string;
  baseUrl: string;
}

export function privacyPage(i: LegalPageInput): string {
  return htmlPage(
    'Stand-In privacy policy',
    `<div class="card"><h1>Privacy policy</h1>
<p class="muted">Stand-In is a hackathon demonstration, not a commercial service. This page describes exactly what the demo server at ${escapeHtml(i.baseUrl)} stores.</p>
<h2>What Stand-In does</h2>
<p>Stand-In takes a support request (for example "call BharatNet about my broadband outage"), opens a case, and places a <strong>simulated</strong> phone call to a fake business that runs inside the same server. It never dials real phone numbers or contacts real businesses.</p>
<h2>What is stored</h2>
<ul>
<li><strong>Cases</strong>: the business name, your goal, the outcome you want, and the facts you provide (such as an account number).</li>
<li><strong>Calls</strong>: the simulated call transcript, its outcome (ticket ID, promised date) and a tamper-evident event log.</li>
<li><strong>Account linking</strong>: if you link Stand-In to Alexa, the server keeps hashes of the OAuth access and refresh tokens it issued to Alexa. It does not receive your Amazon password, name, email or voice recordings.</li>
</ul>
<h2>Masking and secrets</h2>
<p>Sensitive values are masked when they are written: one-time passwords, PINs and card numbers are never sent to the language model, the logs or text-to-speech, and transcripts store them masked. Stand-In asks you to join the call instead of reading such values out.</p>
<h2>Retention and deletion</h2>
<ul>
<li>Cases, their calls and transcripts are deleted automatically ${i.ttlDays} days after their last update.</li>
<li>You can delete any case at any time by asking Stand-In to delete it (the <code>delete_case</code> tool).</li>
<li>Access tokens expire after about an hour and refresh tokens after 30 days of non-use; unlinking in the Alexa app stops all access.</li>
</ul>
<h2>Sharing</h2>
<p>Nothing is sold or shared for advertising. When the hosted demo runs in AWS mode, request text is processed by Amazon Bedrock (language model) and Amazon Polly (speech) in the deployment's AWS account. Server logs record only the method, path, status and timing of each request, never request bodies, tokens or transcripts.</p>
<h2>Contact</h2>
<p>Questions or deletion requests: ${escapeHtml(i.contact)}.</p></div>
<p class="muted"><a href="/terms">Terms of use</a></p>`,
  );
}

export function termsPage(i: LegalPageInput): string {
  return htmlPage(
    'Stand-In terms of use',
    `<div class="card"><h1>Terms of use</h1>
<p class="muted">These terms cover the Stand-In demo server at ${escapeHtml(i.baseUrl)} and the Stand-In Alexa+ add-on that connects to it.</p>
<h2>A demo, provided as is</h2>
<p>Stand-In is a hackathon project offered free of charge, as is, without warranty of any kind, and may be changed or switched off at any time. The source code is MIT licensed.</p>
<h2>No real calls</h2>
<p>All calls are simulated against fictional businesses (such as "BharatNet Broadband"). Ticket IDs, dates and promises shown by Stand-In are invented by the simulation and create no obligation for any real company. Do not rely on them.</p>
<h2>Acceptable use</h2>
<ul>
<li>Do not enter real one-time passwords, PINs, card numbers or other secrets. Stand-In masks them, but this is a demo.</li>
<li>Do not attempt to bypass the rate limits, spend caps, allowlist or calling-hours checks, or to access other people's data.</li>
</ul>
<h2>Your data</h2>
<p>How data is stored, masked and deleted (${i.ttlDays}-day retention, per-case delete) is described in the <a href="/privacy">privacy policy</a>.</p>
<h2>Trademarks</h2>
<p>Stand-In is not affiliated with or endorsed by Amazon. Alexa and related marks belong to Amazon.com, Inc. or its affiliates.</p>
<h2>Contact</h2>
<p>${escapeHtml(i.contact)}.</p></div>
<p class="muted"><a href="/privacy">Privacy policy</a></p>`,
  );
}
