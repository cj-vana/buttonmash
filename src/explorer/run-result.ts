import type { ResolvedConfig } from '../config/load';
import { compareWithBaseline, isFailingFinding, type BaselineSnapshot } from '../baseline';
import { EXIT, type LoggedAction, type RunResult, type Severity, type Signal } from '../core/types';
import { aggregateFindings } from '../detectors/aggregate';
import { version } from '../version';

export interface RunCompletion {
  complete: boolean;
  internalError: boolean;
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
  const exitCode = failed
    ? EXIT.FINDINGS
    : input.completion.internalError
      ? EXIT.ERROR
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
    actions: input.actions,
    findings,
    baseline: baselineComparison,
    resolvedConfig: redactedConfig(input.cfg),
  };
}
