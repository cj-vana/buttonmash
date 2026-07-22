/** Cross-run finding comparison for incremental CI adoption. */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod';

import {
  EXIT,
  SEVERITY_ORDER,
  type BaselineComparison,
  type BaselineFindingSummary,
  type Finding,
  type Severity,
} from './core/types';
import { fnv1a } from './core/hash';

const BaselineFindingSchema = z.object({
  dedupKey: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  category: z.string(),
  title: z.string(),
  location: z.object({
    url: z.string(),
    selector: z.string().optional(),
    fp: z.string().optional(),
  }),
});

const BaselineResultSchema = z.object({
  schemaVersion: z.literal(1),
  tool: z.object({ version: z.string() }),
  run: z.object({ exitCode: z.number(), complete: z.boolean().optional() }),
  findings: z.array(BaselineFindingSchema),
  resolvedConfig: z.record(z.unknown()).optional(),
});

export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineError';
  }
}

export interface BaselineSnapshot {
  source: string;
  findings: BaselineFindingSummary[];
  complete: boolean;
  toolVersion: string;
  comparisonKey?: string;
}

export interface BaselineClassification {
  findings: Finding[];
  comparison: BaselineComparison;
}

/** Stable config identity for deciding whether an absent finding was exercised. */
export function baselineComparisonKey(config: unknown): string | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  delete clone.report;
  delete clone.logLevel;
  delete clone.configPath;

  const baseline = clone.baseline as { identity?: unknown } | undefined;
  const identity = typeof baseline?.identity === 'string' ? baseline.identity : undefined;
  if (identity) clone.baseline = { identity };
  else delete clone.baseline;

  const auth = clone.auth as
    | {
        storageState?: unknown;
        loginScript?: { username?: unknown; password?: unknown };
        basicAuth?: { username?: unknown; password?: unknown };
      }
    | undefined;
  const opaqueAuth = Boolean(auth?.storageState || auth?.loginScript || auth?.basicAuth);
  const headers = clone.headers as Record<string, unknown> | undefined;
  const opaqueHeaders = Boolean(headers && Object.keys(headers).length > 0);
  if ((opaqueAuth || opaqueHeaders) && !identity) return undefined;

  if (auth?.storageState) auth.storageState = '<storageState>';
  if (auth?.loginScript) {
    auth.loginScript.username = '***';
    auth.loginScript.password = '***';
  }
  if (auth?.basicAuth) auth.basicAuth = { username: '***', password: '***' };

  if (headers) {
    for (const key of Object.keys(headers)) headers[key] = '***';
  }

  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  };
  return fnv1a(JSON.stringify(stable(clone)));
}

/** Read and minimally validate a previous canonical results.json. */
export async function loadBaseline(path: string): Promise<BaselineSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new BaselineError(`Could not read baseline ${path}: ${(err as Error).message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new BaselineError(`Could not parse baseline ${path}: ${(err as Error).message}`);
  }

  const parsed = BaselineResultSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || '(root)';
    throw new BaselineError(
      `Invalid buttonmash baseline ${path}: ${where}: ${issue?.message ?? 'invalid report'}`,
    );
  }

  return {
    source: basename(path),
    findings: parsed.data.findings,
    complete: parsed.data.run.complete === true && parsed.data.run.exitCode !== EXIT.ERROR,
    toolVersion: parsed.data.tool.version,
    comparisonKey: baselineComparisonKey(parsed.data.resolvedConfig),
  };
}

/** Classify current findings without mutating caller-owned objects. */
export function compareWithBaseline(
  findings: Finding[],
  baseline: BaselineSnapshot,
  options: { currentConfig: unknown; currentToolVersion: string; complete: boolean },
): BaselineClassification {
  const previous = new Map(baseline.findings.map((finding) => [finding.dedupKey, finding]));
  const current = new Set<string>();
  let newFindings = 0;
  let updatedFindings = 0;
  let existingFindings = 0;

  const classified = findings.map((finding): Finding => {
    current.add(finding.dedupKey);
    const prior = previous.get(finding.dedupKey);
    if (!prior) {
      newFindings += 1;
      return { ...finding, baselineState: 'new' };
    }
    if (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[prior.severity]) {
      updatedFindings += 1;
      return { ...finding, baselineState: 'updated' };
    }
    existingFindings += 1;
    return { ...finding, baselineState: 'existing' };
  });

  const absent = baseline.findings
    .filter((finding) => !current.has(finding.dedupKey))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.title.localeCompare(b.title),
    );
  const currentKey = baselineComparisonKey(options.currentConfig);
  const comparable =
    options.complete &&
    baseline.complete &&
    baseline.toolVersion === options.currentToolVersion &&
    baseline.comparisonKey !== undefined &&
    baseline.comparisonKey === currentKey;

  return {
    findings: classified,
    comparison: {
      source: baseline.source,
      comparable,
      newFindings,
      updatedFindings,
      existingFindings,
      resolvedFindings: comparable ? absent : [],
      notObservedFindings: comparable ? [] : absent,
    },
  };
}

/** Whether a finding contributes to the run/JUnit failure verdict. */
export function isFailingFinding(finding: Finding, failOn: Severity, failOnNew = false): boolean {
  if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[failOn]) return false;
  return !failOnNew || finding.baselineState === 'new' || finding.baselineState === 'updated';
}
