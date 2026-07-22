/**
 * GitHub Actions integration: inline ::error/::warning annotations for the top
 * findings, plus a markdown job summary. No-ops when not running on GHA.
 */
import { appendFileSync } from 'node:fs';

import { isFailingFinding } from '../baseline';
import { SEVERITY_ORDER, type RunResult, type Severity } from '../core/types';

/** Escape annotation message data (%/CR/LF). */
function enc(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape an annotation *property* value — additionally `:` and `,` per the
 *  workflow-command grammar (mirrors @actions/core escapeProperty). */
function encProp(s: string): string {
  return enc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function annLevel(s: Severity, failing: boolean): 'error' | 'warning' | 'notice' {
  if (failing) return 'error';
  if (s === 'critical' || s === 'high' || s === 'medium') return 'warning';
  return 'notice';
}

export function emitGitHub(result: RunResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const stateOrder = { new: 0, updated: 1, existing: 2 } as const;
  const orderedFindings = [...result.findings].sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
      (a.baselineState ? stateOrder[a.baselineState] : 0) -
        (b.baselineState ? stateOrder[b.baselineState] : 0),
  );
  const annotationFindings = result.config.failOnNew
    ? orderedFindings.filter((finding) => finding.baselineState !== 'existing')
    : orderedFindings;

  // GitHub caps displayed annotations (~10 each) — emit only the top findings.
  for (const f of annotationFindings.slice(0, 10)) {
    const failing = isFailingFinding(f, result.config.failOn, result.config.failOnNew ?? false);
    const level = annLevel(f.severity, failing);
    const prefix = f.baselineState ? `[${f.baselineState.toUpperCase()}] ` : '';
    process.stdout.write(
      `::${level} title=${encProp(`${prefix}${f.title}`.slice(0, 80))}::${enc(`${f.location.url} — ${f.title}`)}\n`,
    );
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const f = result.stats.findingsBySeverity;
  const verdict = result.run.exitCode === 0 ? '✅ PASSED' : '❌ FAILED';
  // Truncate BEFORE escaping (a cut mid-escape leaves a dangling backslash),
  // and escape the URL cell too — browsers don't encode `|` in query strings.
  const cell = (s: string, max: number) => s.slice(0, max).replace(/\|/g, '\\|');
  const rows = orderedFindings
    .slice(0, 50)
    .map((x) =>
      result.baseline
        ? `| ${x.baselineState ?? 'new'} | ${x.severity} | ${cell(x.title, 100)} | ${x.count} | ${cell(x.location.url, 120)} |`
        : `| ${x.severity} | ${cell(x.title, 100)} | ${x.count} | ${cell(x.location.url, 120)} |`,
    )
    .join('\n');
  const delta = result.baseline
    ? `**Delta:** ${result.baseline.newFindings} new · ${result.baseline.updatedFindings} updated · ${result.baseline.existingFindings} existing · ${result.baseline.resolvedFindings.length} resolved` +
      (result.baseline.notObservedFindings.length
        ? ` · ${result.baseline.notObservedFindings.length} not observed`
        : '') +
      '\n\n'
    : '';
  const tableHeader = result.baseline
    ? '| Status | Severity | Finding | Count | Where |\n|---|---|---|---|---|'
    : '| Severity | Finding | Count | Where |\n|---|---|---|---|';

  const md =
    `## 🐒 buttonmash — ${verdict}\n\n` +
    `**Seed:** \`${result.config.seed}\` · **Actions:** ${result.stats.actionsTaken} · ` +
    `**Pages:** ${result.stats.pagesVisited} · **States:** ${result.stats.statesDiscovered}\n\n` +
    `**Findings:** ${f.critical} critical · ${f.high} high · ${f.medium} medium · ${f.low} low · ${f.info} info\n\n` +
    delta +
    (result.findings.length
      ? `${tableHeader}\n${rows}\n`
      : `No findings — the monkey could not break anything. 🎉\n`);

  try {
    appendFileSync(summaryPath, md);
  } catch {
    /* summary is best-effort */
  }
}
