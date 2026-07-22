import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Finding, RunResult, Severity } from '../src/core/types';
import { emitGitHub } from '../src/report/github';

function finding(over: Partial<Finding>): Finding {
  return {
    id: 'finding',
    dedupKey: 'finding',
    severity: 'high',
    category: 'js-error',
    title: 'Finding',
    description: 'boom',
    count: 1,
    location: { url: 'https://example.test/app' },
    reproSteps: [],
    firstSeenStep: 0,
    artifacts: [],
    ...over,
  };
}

function result(findings: Finding[], failOn: Severity = 'high'): RunResult {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return {
    schemaVersion: 1,
    tool: { name: 'buttonmash', version: '0.2.0' },
    run: {
      id: 'ci',
      startedAt: '2026-07-22T00:00:00.000Z',
      finishedAt: '2026-07-22T00:00:01.000Z',
      durationMs: 1000,
      target: 'https://example.test',
      browser: 'chromium',
      viewport: { width: 1280, height: 800 },
      exitCode: 1,
      dryRun: false,
      complete: true,
    },
    config: {
      seed: 'ci',
      maxActions: 10,
      maxDurationMs: 1000,
      failOn,
      failOnNew: true,
    },
    stats: {
      actionsTaken: 1,
      pagesVisited: 1,
      statesDiscovered: 1,
      recordsCreated: 0,
      findingsBySeverity: counts,
    },
    actions: [],
    findings,
    baseline: {
      source: 'previous.json',
      comparable: false,
      newFindings: findings.filter((item) => item.baselineState === 'new').length,
      updatedFindings: findings.filter((item) => item.baselineState === 'updated').length,
      existingFindings: findings.filter((item) => item.baselineState === 'existing').length,
      resolvedFindings: [],
      notObservedFindings: [
        {
          dedupKey: 'old',
          severity: 'medium',
          category: 'http-4xx',
          title: 'Old finding',
          location: { url: 'https://example.test/old' },
        },
      ],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('GitHub Actions reporting', () => {
  it('prioritizes regressions, suppresses existing annotations, and writes delta summary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-github-'));
    const summary = join(directory, 'summary.md');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      emitGitHub(
        result([
          finding({
            dedupKey: 'known',
            title: 'Known critical',
            severity: 'critical',
            baselineState: 'existing',
          }),
          finding({
            dedupKey: 'updated',
            title: 'Updated high',
            baselineState: 'updated',
          }),
          finding({
            dedupKey: 'new',
            title: 'New info',
            severity: 'info',
            baselineState: 'new',
          }),
        ]),
      );

      const annotations = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(annotations).toContain('::error title=[UPDATED] Updated high');
      expect(annotations).toContain('::notice title=[NEW] New info');
      expect(annotations).not.toContain('Known critical');

      const markdown = readFileSync(summary, 'utf8');
      expect(markdown).toContain('1 new · 1 updated · 1 existing');
      expect(markdown).toContain('1 not observed');
      expect(markdown).toContain('| Status | Severity |');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not emit an error annotation below the configured failure threshold', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    emitGitHub(
      result(
        [
          finding({
            title: 'bad: value, 100%\nnext',
            severity: 'high',
            baselineState: 'new',
          }),
        ],
        'critical',
      ),
    );

    const annotation = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(annotation).toContain('::warning');
    expect(annotation).toContain('bad%3A value%2C 100%25%0Anext');
    expect(annotation).not.toContain('::error');
  });
});
