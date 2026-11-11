/**
 * Self-contained single-file HTML report. CSS + JS are inlined and the full
 * result is embedded as a JSON blob rendered client-side. Small screenshots are
 * inlined as base64, once per file even when several findings share one; the
 * originals stay as referenced artifact files.
 *
 * The header (verdict, why, run facts) is plain markup, so it reads without
 * script. The client script adds the tallies, the findings and the pages.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isFailingFinding } from '../baseline';
import { inlineThumb } from '../capture/artifacts';
import type { RunResult } from '../core/types';
import { stopSummary, verdictOf } from './verdict';

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3}
header{border-bottom:1px solid #21262d;background:#161b22}
.wrap{max-width:1100px;margin:0 auto;padding:24px 32px}
.headline{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{margin:0;font-size:20px}
h2{margin:32px 0 12px;font-size:16px}
h2 .note{font-weight:400;font-size:13px;color:#8b949e;margin-left:2px}
.muted{color:#8b949e}
.why{margin:8px 0 16px;font-size:15px}
.meta{display:flex;flex-wrap:wrap;gap:8px 28px;margin:0}
.meta div{min-width:0}
.meta dt{font-size:12px;color:#8b949e}
.meta dd{margin:0;overflow-wrap:anywhere}
code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.summary{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 8px}
.chip{padding:8px 14px;border-radius:8px;background:#161b22;border:1px solid #21262d;min-width:96px}
.chip b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}
.critical{background:#67060c;color:#ffdcd7}.high{background:#7d1a1a;color:#ffd7d5}
.medium{background:#7a5c00;color:#ffe9a8}.low{background:#1f3a5f;color:#cce3ff}.info{background:#30363d;color:#c9d1d9}
.new{background:#1f6f3d;color:#d5ffe2}.updated{background:#7a4b00;color:#fff0c2}.existing{background:#30363d;color:#c9d1d9}.resolved{background:#164f63;color:#d2f4ff}.notobserved{background:#3f344d;color:#eadcff}
.passed{background:#1f6f3d;color:#d5ffe2}.failed{background:#7d1a1a;color:#ffd7d5}.error{background:#7a5c00;color:#ffe9a8}
.verdict{font-size:13px;padding:3px 10px}
details{border:1px solid #21262d;border-radius:8px;margin:0 0 12px;background:#161b22;overflow:hidden}
summary{cursor:pointer;padding:14px 16px;display:flex;gap:10px;align-items:center;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"";flex:none;width:7px;height:7px;border-right:2px solid #8b949e;border-bottom:2px solid #8b949e;transform:rotate(-45deg);transition:transform .15s}
details[open]>summary::before{transform:rotate(45deg)}
summary:hover{background:#1c2129}
summary:focus-visible{outline:2px solid #58a6ff;outline-offset:-2px;border-radius:8px}
.finding .title{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}
.finding .count{color:#8b949e;font-size:12px;white-space:nowrap}
.body{padding:0 16px 16px;border-top:1px solid #21262d}
.kv{color:#8b949e;font-size:12px;margin:10px 0;overflow-wrap:anywhere}
.kv span{margin-right:16px}
.kv b{font-weight:400;color:#c9d1d9}
pre{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
img.shot{max-width:100%;border-radius:8px;border:1px solid #21262d;margin-top:10px}
a{color:#58a6ff}
a:focus-visible{outline:2px solid #58a6ff;outline-offset:2px;border-radius:2px}
.empty{padding:40px 16px;text-align:center;color:#3fb950;font-size:16px}
.empty.plain{color:#8b949e}
.pages{margin-top:32px}
.pages summary{font-weight:600}
.pages table{width:100%;border-collapse:collapse;font-size:13px}
.pages th{font-weight:400;font-size:12px;color:#8b949e;text-align:left}
.pages th,.pages td{padding:8px 16px;border-top:1px solid #21262d;vertical-align:top}
.pages td:first-child{overflow-wrap:anywhere}
.pages .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.pages p{margin:0;padding:10px 16px;border-top:1px solid #21262d;color:#8b949e;font-size:13px}
footer{color:#8b949e;font-size:13px}
footer .wrap{border-top:1px solid #21262d;padding-top:16px}
@media (max-width:600px){.wrap{padding:16px}.chip{min-width:84px;flex:1 1 auto;padding:8px 10px}.pages th,.pages td{padding:8px 10px}.pages p{padding:10px}.finding>summary{flex-wrap:wrap}.finding .title{order:3;flex:1 0 100%;padding-left:17px}.finding .count{margin-left:auto}}
@media (prefers-reduced-motion:reduce){summary::before{transition:none}}
`;

const CLIENT = `
const data = JSON.parse(document.getElementById('data').textContent);
const el = (t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;};
const esc = s => String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const app = document.getElementById('app');
const r = data;
const shots = r.screenshots || {};
const view = r.view;
const sevs =['critical','high','medium','low','info'];
const sum = el('div','summary');
sum.appendChild(el('div','chip','<b>'+r.stats.actionsTaken+'</b><span class="muted">actions</span>'));
sum.appendChild(el('div','chip','<b>'+r.stats.pagesVisited+'</b><span class="muted">pages</span>'));
sum.appendChild(el('div','chip','<b>'+r.stats.statesDiscovered+'</b><span class="muted">states</span>'));
sum.appendChild(el('div','chip','<b>'+r.findings.length+'</b><span class="muted">findings</span>'));
if(r.baseline){
  sum.appendChild(el('div','chip','<b>'+r.baseline.newFindings+'</b><span class="badge new">new</span>'));
  sum.appendChild(el('div','chip','<b>'+r.baseline.updatedFindings+'</b><span class="badge updated">updated</span>'));
  sum.appendChild(el('div','chip','<b>'+r.baseline.existingFindings+'</b><span class="badge existing">existing</span>'));
  sum.appendChild(el('div','chip','<b>'+r.baseline.resolvedFindings.length+'</b><span class="badge resolved">resolved</span>'));
  if(r.baseline.notObservedFindings.length) sum.appendChild(el('div','chip','<b>'+r.baseline.notObservedFindings.length+'</b><span class="badge notobserved">not observed</span>'));
}
for(const s of sevs){const n=r.stats.findingsBySeverity[s]||0; if(n) sum.appendChild(el('div','chip','<b>'+n+'</b><span class="badge '+s+'">'+s+'</span>'));}
app.appendChild(sum);
const heading = (text,note)=>{const h=el('h2',null,esc(text)+' '); if(note) h.appendChild(el('span','note',esc(note))); app.appendChild(h);};
const fact = (label,value)=>'<span>'+label+' <b>'+esc(value)+'</b></span> ';
const card = f => {
  const d=el('details','finding'); const s=el('summary');
  s.innerHTML=(f.baselineState?'<span class="badge '+f.baselineState+'">'+f.baselineState+'</span>':'')+'<span class="badge '+f.severity+'">'+f.severity+'</span><span class="title">'+esc(f.title)+'</span><span class="count">×'+f.count+'</span>';
  d.appendChild(s);
  const b=el('div','body');
  b.appendChild(el('div','kv',fact('category',f.category)+fact('url',f.location.url)+(f.location.selector?fact('selector',f.location.selector):'')));
  b.appendChild(el('pre',null,esc(f.description)));
  if(f.reproSteps && f.reproSteps.length){
    const repro=f.reproSteps.map(x=>'#'+x.step+' '+x.kind+(x.target?' "'+esc(x.target)+'"':'')+(x.value?' = '+esc(x.value):'')).join('\\n');
    b.appendChild(el('div','kv','repro (seed '+esc(r.config.seed)+'):'));
    b.appendChild(el('pre',null,repro));
  }
  for(const a of (f.artifacts||[])){
    if(a.type==='screenshot'||a.type==='thumbnail'){
      const uri=shots[a.path];
      if(uri){const i=el('img','shot');i.src=uri;i.alt='Screenshot at step '+f.firstSeenStep;b.appendChild(i);}
      b.appendChild(el('div','kv','<a href="'+esc(a.path)+'">open screenshot</a>'));
    } else if(a.type==='trace'){ b.appendChild(el('div','kv','<a href="'+esc(a.path)+'">trace.zip</a>, open with: npx playwright show-trace '+esc(a.path))); }
  }
  d.appendChild(b); return d;
};
if(!r.findings.length){
  app.appendChild(view.state==='passed'
    ? el('div','empty','No findings. The monkey could not break anything.')
    : el('div','empty plain','No findings were recorded before the run stopped.'));
}
const fails = r.findings.filter((f,i)=>view.failing[i]);
const rest = r.findings.filter((f,i)=>!view.failing[i]);
if(fails.length){ heading('Fails the build ('+fails.length+')', view.failRule); for(const f of fails) app.appendChild(card(f)); }
if(rest.length){ heading('Does not fail the build ('+rest.length+')', view.passRule); for(const f of rest) app.appendChild(card(f)); }
const brief = (title,badge,cls,list) => {
  app.appendChild(el('h2',null,title));
  for(const f of list){
    const d=el('details','finding'); const s=el('summary');
    s.innerHTML='<span class="badge '+cls+'">'+badge+'</span><span class="badge '+f.severity+'">'+f.severity+'</span><span class="title">'+esc(f.title)+'</span>';
    d.appendChild(s);
    const b=el('div','body');
    b.appendChild(el('div','kv',fact('category',f.category)+fact('url',f.location.url)));
    d.appendChild(b); app.appendChild(d);
  }
};
if(r.baseline && r.baseline.resolvedFindings.length) brief('Resolved since baseline','resolved','resolved',r.baseline.resolvedFindings);
if(r.baseline && r.baseline.notObservedFindings.length) brief('Not observed (runs were not comparable)','not observed','notobserved',r.baseline.notObservedFindings);
if(r.pages && r.pages.length){
  const d=el('details','pages');
  d.appendChild(el('summary',null,'Pages visited ('+r.pages.length+')'));
  const rows=r.pages.map(p=>'<tr><td>'+esc(p.url)+'</td><td class="num">'+p.actions+'</td><td class="num">'+p.findings+'</td></tr>').join('');
  d.appendChild(el('table',null,'<thead><tr><th scope="col">Page</th><th scope="col" class="num">Actions</th><th scope="col" class="num">Findings</th></tr></thead><tbody>'+rows+'</tbody>'));
  if(view.queuedNote) d.appendChild(el('p',null,esc(view.queuedNote)));
  app.appendChild(d);
}
`;

/** Escape a value for safe interpolation into HTML markup. */
function h(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]!,
  );
}

/** A `<` inside the embedded JSON would let page text close the script tag. */
const ESCAPED_LT = '\\' + 'u003c';

export function buildHtml(result: RunResult, outDir: string): string {
  // Findings first seen at the same step share one PNG, so each file is inlined
  // once and the client looks it up by path.
  const screenshots = new Map<string, string>();
  for (const f of result.findings) {
    for (const a of f.artifacts) {
      if (a.type !== 'screenshot' || screenshots.has(a.path)) continue;
      const uri = inlineThumb(outDir, a.path, a.mime);
      if (uri) screenshots.set(a.path, uri);
    }
  }
  const verdict = verdictOf(result);
  const { failOn } = result.config;
  const failOnNew = result.config.failOnNew ?? false;
  const stop = result.run.stop;
  const queued = stop?.pagesQueued ?? 0;
  // What the client needs beyond the result itself, worked out once here so
  // the page and the other reports cannot disagree on what fails the build.
  const view = {
    state: verdict.state,
    failing: result.findings.map((finding) => isFailingFinding(finding, failOn, failOnNew)),
    failRule: failOnNew ? `new findings at or above ${failOn}` : `at or above ${failOn}`,
    passRule: failOnNew ? `below ${failOn}, or already in the baseline` : `below ${failOn}`,
    queuedNote:
      queued > 0
        ? `${queued} more ${queued === 1 ? 'page was' : 'pages were'} found but not visited before the run stopped.`
        : '',
  };
  const enriched = { ...result, screenshots: Object.fromEntries(screenshots), view };
  const json = JSON.stringify(enriched).replace(/</g, ESCAPED_LT);
  const f = result.stats.findingsBySeverity;
  const fact = (label: string, value: string): string =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const facts = [
    fact('Target', h(result.run.target)),
    fact('Browser', h(result.run.browser)),
    fact('Seed', `<code>${h(result.config.seed)}</code>`),
    fact('Duration', `${(result.run.durationMs / 1000).toFixed(1)}s`),
    fact('Started', h(new Date(result.run.startedAt).toLocaleString())),
    stop ? fact('Stopped', h(stopSummary(stop))) : '',
  ].join('');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>buttonmash report: ${verdict.label}</title><style>${STYLE}</style></head><body>` +
    `<header><div class="wrap"><div class="headline"><h1>🐒 buttonmash report</h1>` +
    `<span class="badge verdict ${verdict.state}">${verdict.label}</span></div>` +
    `<p class="why">${h(verdict.detail)}.</p>` +
    `<dl class="meta">${facts}</dl></div></header>` +
    `<main class="wrap"><div id="app"></div></main>` +
    `<footer><div class="wrap">buttonmash ${h(result.tool.version)}. ` +
    `To run this again with the same seed and settings, use ` +
    `<code>buttonmash replay results.json</code> from this folder.</div></footer>` +
    `<script id="data" type="application/json">${json}</script>` +
    `<script>${CLIENT}</script>` +
    `<!-- severity tallies: ${JSON.stringify(f)} -->` +
    `</body></html>`
  );
}

export async function writeHtmlReport(result: RunResult, outDir: string): Promise<string> {
  const rel = 'report.html';
  await writeFile(join(outDir, rel), buildHtml(result, outDir), 'utf8');
  return rel;
}
