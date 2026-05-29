/**
 * Self-contained single-file HTML report. CSS + JS are inlined and the full
 * result is embedded as a JSON blob rendered client-side. Small screenshots are
 * inlined as base64 thumbnails; the originals stay as referenced artifact files.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inlineThumb } from '../capture/artifacts';
import type { RunResult } from '../core/types';

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3}
header{padding:24px 32px;border-bottom:1px solid #21262d;background:#161b22}
h1{margin:0 0 4px;font-size:20px}
.muted{color:#8b949e}
.wrap{max-width:1100px;margin:0 auto;padding:24px 32px}
.summary{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 24px}
.chip{padding:8px 14px;border-radius:8px;background:#161b22;border:1px solid #21262d;min-width:96px}
.chip b{display:block;font-size:22px}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.critical{background:#67060c;color:#ffdcd7}.high{background:#7d1a1a;color:#ffd7d5}
.medium{background:#7a5c00;color:#ffe9a8}.low{background:#1f3a5f;color:#cce3ff}.info{background:#30363d;color:#c9d1d9}
.finding{border:1px solid #21262d;border-radius:10px;margin:0 0 14px;background:#161b22;overflow:hidden}
.finding>summary{cursor:pointer;padding:14px 16px;display:flex;gap:10px;align-items:center;list-style:none}
.finding>summary::-webkit-details-marker{display:none}
.finding .title{flex:1;font-weight:600}
.finding .count{color:#8b949e;font-size:12px}
.body{padding:0 16px 16px;border-top:1px solid #21262d}
.kv{color:#8b949e;font-size:12px;margin:10px 0;word-break:break-all}
pre{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap}
img.shot{max-width:100%;border-radius:8px;border:1px solid #21262d;margin-top:10px}
a{color:#58a6ff}
.empty{padding:40px;text-align:center;color:#3fb950;font-size:16px}
`;

const CLIENT = `
const data = JSON.parse(document.getElementById('data').textContent);
const el = (t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;};
const esc = s => String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const app = document.getElementById('app');
const r = data;
const sevs = ['critical','high','medium','low','info'];
const sum = el('div','summary');
sum.appendChild(el('div','chip','<b>'+r.stats.actionsTaken+'</b><span class="muted">actions</span>'));
sum.appendChild(el('div','chip','<b>'+r.stats.pagesVisited+'</b><span class="muted">pages</span>'));
sum.appendChild(el('div','chip','<b>'+r.stats.statesDiscovered+'</b><span class="muted">states</span>'));
sum.appendChild(el('div','chip','<b>'+r.findings.length+'</b><span class="muted">findings</span>'));
for(const s of sevs){const n=r.stats.findingsBySeverity[s]||0; if(n) sum.appendChild(el('div','chip','<b>'+n+'</b><span class="badge '+s+'">'+s+'</span>'));}
app.appendChild(sum);
if(!r.findings.length){app.appendChild(el('div','empty','✓ No findings — the monkey could not break anything.'));}
for(const f of r.findings){
  const d=el('details','finding'); const s=el('summary');
  s.innerHTML='<span class="badge '+f.severity+'">'+f.severity+'</span><span class="title">'+esc(f.title)+'</span><span class="count">×'+f.count+'</span>';
  d.appendChild(s);
  const b=el('div','body');
  b.appendChild(el('div','kv','category: '+esc(f.category)+' · url: '+esc(f.location.url)+(f.location.selector?' · selector: '+esc(f.location.selector):'')));
  b.appendChild(el('pre',null,esc(f.description)));
  if(f.reproSteps && f.reproSteps.length){
    const repro=f.reproSteps.map(x=>'#'+x.step+' '+x.kind+(x.target?' "'+esc(x.target)+'"':'')+(x.value?' = '+esc(x.value):'')).join('\\n');
    b.appendChild(el('div','kv','repro (seed '+esc(r.config.seed)+'):'));
    b.appendChild(el('pre',null,repro));
  }
  for(const a of (f.artifacts||[])){
    if(a.type==='screenshot'||a.type==='thumbnail'){
      if(a.dataUri){const i=el('img','shot');i.src=a.dataUri;b.appendChild(i);}
      b.appendChild(el('div','kv','<a href="'+esc(a.path)+'">open screenshot</a>'));
    } else if(a.type==='trace'){ b.appendChild(el('div','kv','<a href="'+esc(a.path)+'">trace.zip</a> — open with: npx playwright show-trace '+esc(a.path))); }
  }
  d.appendChild(b); app.appendChild(d);
}
`;

/** Escape a value for safe interpolation into HTML markup. */
function h(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]!,
  );
}

export function buildHtml(result: RunResult, outDir: string): string {
  const enriched: RunResult = structuredClone(result);
  for (const f of enriched.findings) {
    for (const a of f.artifacts) {
      if (a.type === 'screenshot') {
        const uri = inlineThumb(outDir, a.path, a.mime);
        if (uri) a.dataUri = uri;
      }
    }
  }
  const json = JSON.stringify(enriched).replace(/</g, '\\u003c');
  const f = result.stats.findingsBySeverity;
  const verdict = result.run.exitCode === 0 ? 'PASSED' : 'FAILED';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>buttonmash report — ${verdict}</title><style>${STYLE}</style></head><body>` +
    `<header><h1>🐒 buttonmash report — ${verdict}</h1>` +
    `<div class="muted">${h(result.run.target)} · ${h(result.run.browser)} · seed <code>${h(result.config.seed)}</code> · ` +
    `${(result.run.durationMs / 1000).toFixed(1)}s · ${h(new Date(result.run.startedAt).toLocaleString())}</div></header>` +
    `<div class="wrap"><div id="app"></div></div>` +
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
