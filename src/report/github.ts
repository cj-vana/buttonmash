/**
 * GitHub Actions integration: inline ::error/::warning annotations for the top
 * findings, plus a markdown job summary. No-ops when not running on GHA.
 */
import { appendFileSync } from 'node:fs';

import type { RunResult, Severity } from '../core/types';

/** Escape annotation message data (%/CR/LF). */
function enc(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape an annotation *property* value — additionally `:` and `,` per the
 *  workflow-command grammar (mirrors @actions/core escapeProperty). */
function encProp(s: string): string {
  return enc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function annLevel(s: Severity): 'error' | 'warning' | 'notice' {
  if (s === 'critical' || s === 'high') return 'error';
  if (s === 'medium') return 'warning';
  return 'notice';
}

export function emitGitHub(result: RunResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  // GitHub caps displayed annotations (~10 each) — emit only the top findings.
  for (const f of result.findings.slice(0, 10)) {
    const level = annLevel(f.severity);
    process.stdout.write(`::${level} title=${encProp(f.title.slice(0, 80))}::${enc(`${f.location.url} — ${f.title}`)}\n`);
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const f = result.stats.findingsBySeverity;
  const verdict = result.run.exitCode === 0 ? '✅ PASSED' : '❌ FAILED';
  const rows = result.findings
    .slice(0, 50)
    .map((x) => `| ${x.severity} | ${x.title.replace(/\|/g, '\\|').slice(0, 100)} | ${x.count} | ${x.location.url} |`)
    .join('\n');

  const md =
    `## 🐒 buttonmash — ${verdict}\n\n` +
    `**Seed:** \`${result.config.seed}\` · **Actions:** ${result.stats.actionsTaken} · ` +
    `**Pages:** ${result.stats.pagesVisited} · **States:** ${result.stats.statesDiscovered}\n\n` +
    `**Findings:** ${f.critical} critical · ${f.high} high · ${f.medium} medium · ${f.low} low · ${f.info} info\n\n` +
    (result.findings.length
      ? `| Severity | Finding | Count | Where |\n|---|---|---|---|\n${rows}\n`
      : `No findings — the monkey could not break anything. 🎉\n`);

  try {
    appendFileSync(summaryPath, md);
  } catch {
    /* summary is best-effort */
  }
}
