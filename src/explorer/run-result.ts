import type { ResolvedConfig } from '../config/load';
import { compareWithBaseline, isFailingFinding, type BaselineSnapshot } from '../baseline';
import { normalizeUrl } from '../core/hash';
import {
  EXIT,
  type Finding,
  type LoggedAction,
  type PageVisit,
  type RunResult,
  type RunStop,
  type Severity,
  type Signal,
} from '../core/types';
import { aggregateFindings } from '../detectors/aggregate';
import { version } from '../version';

export interface RunCompletion {
  complete: boolean;
  incompleteExitCode: typeof EXIT.FINDINGS | typeof EXIT.ERROR;
}

export interface FinalizeRunInput {
  cfg: ResolvedConfig;
  baseline?: BaselineSnapshot;
  startedAt: Date;
  startTimeMs: number;
  signals: Signal[];
  actions: LoggedAction[];
  screenshots: Map<number, string>;
  tracePath?: string;
  pagesVisited: number;
  /** Normalized URLs of the pages visited, in visit order. */
  pages?: string[];
  stop?: RunStop;
  statesDiscovered: number;
  recordsCreated: number;
  completion: RunCompletion;
}

function redactedConfig(cfg: ResolvedConfig): Record<string, unknown> {
  const resolved = JSON.parse(JSON.stringify(cfg)) as {
    configPath?: unknown;
    headers?: Record<string, string>;
    auth?: {
      storageState?: string;
      loginScript?: { username?: string; password?: string };
      basicAuth?: { username: string; password: string };
    };
    baseline?: { path?: string };
  } & Record<string, unknown>;

  delete resolved.configPath;
  if (resolved.auth?.storageState) resolved.auth.storageState = '<storageState>';
  if (resolved.auth?.loginScript) {
    resolved.auth.loginScript.username = '***';
    resolved.auth.loginScript.password = '***';
  }
  if (resolved.auth?.basicAuth) {
    resolved.auth.basicAuth = { username: '***', password: '***' };
  }
  if (resolved.headers) {
    for (const key of Object.keys(resolved.headers)) resolved.headers[key] = '***';
  }
  if (resolved.baseline?.path) resolved.baseline.path = '<baseline>';
  return resolved;
}

/** Actions and findings per visited page. Both are matched on the normalized URL. */
function pageVisits(urls: string[], actions: LoggedAction[], findings: Finding[]): PageVisit[] {
  const tally = (raw: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const url of raw) {
      const key = normalizeUrl(url);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const actionCounts = tally(actions.map((action) => action.url));
  const findingCounts = tally(findings.map((finding) => finding.location.url));
  return urls.map((url) => ({
    url,
    actions: actionCounts.get(url) ?? 0,
    findings: findingCounts.get(url) ?? 0,
  }));
}

/** Aggregate signals, apply the baseline, redact config, and build the report contract. */
export function finalizeRun(input: FinalizeRunInput): RunResult {
  let findings = aggregateFindings({
    signals: input.signals,
    actions: input.actions,
    screenshots: input.screenshots,
  });
  if (input.tracePath && findings.length) {
    findings[0]!.artifacts.push({
      type: 'trace',
      path: input.tracePath,
      mime: 'application/zip',
    });
  }

  const complete = input.completion.complete;
  let baselineComparison;
  if (input.baseline) {
    const classified = compareWithBaseline(findings, input.baseline, {
      currentConfig: input.cfg,
      currentToolVersion: version,
      complete,
    });
    findings = classified.findings;
    baselineComparison = classified.comparison;
  }

  const findingsBySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) findingsBySeverity[finding.severity] += 1;

  const failed = findings.some((finding) =>
    isFailingFinding(finding, input.cfg.failOn, input.cfg.baseline.failOnNew),
  );
  // An incomplete run cannot prove the target is clean. Safety/target failures
  // remain exit 1 while tool failures and interruption remain exit 2, even when
  // --fail-on-new classifies every observed finding as existing.
  const exitCode = !complete
    ? input.completion.incompleteExitCode
    : failed
      ? EXIT.FINDINGS
      : EXIT.CLEAN;
  const finishedAt = new Date();

  return {
    schemaVersion: 1,
    tool: { name: 'buttonmash', version },
    run: {
      id: input.cfg.seed,
      startedAt: input.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - input.startTimeMs,
      target: input.cfg.target,
      browser: input.cfg.browser,
      viewport: input.cfg.viewport,
      exitCode,
      dryRun: input.cfg.guardrails.dryRun,
      complete,
      stop: input.stop,
    },
    config: {
      seed: input.cfg.seed,
      maxActions: input.cfg.budget.maxActions,
      maxDurationMs: input.cfg.budget.maxDurationMs,
      failOn: input.cfg.failOn,
      failOnNew: input.cfg.baseline.failOnNew,
    },
    stats: {
      actionsTaken: input.actions.length,
      pagesVisited: input.pagesVisited,
      statesDiscovered: input.statesDiscovered,
      recordsCreated: input.recordsCreated,
      findingsBySeverity,
    },
    pages: input.pages && pageVisits(input.pages, input.actions, findings),
    actions: input.actions,
    findings,
    baseline: baselineComparison,
    resolvedConfig: redactedConfig(input.cfg),
  };
}
