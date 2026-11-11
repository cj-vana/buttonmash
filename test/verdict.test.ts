import { describe, expect, it } from 'vitest';

import type { Finding, RunResult, RunStop, Severity } from '../src/core/types';
import { stopSummary, verdictOf } from '../src/report/verdict';

function finding(severity: Severity, baselineState?: Finding['baselineState']): Finding {
  return {
    id: severity,
    dedupKey: severity,
    severity,
    category: 'js-error',
    title: 'Finding',
    description: 'boom',
    count: 1,
    location: { url: 'https://example.test/app' },
    reproSteps: [],
    firstSeenStep: 0,
    artifacts: [],
    baselineState,
  };
}

function result(
  run: Partial<RunResult['run']>,
  findings: Finding[] = [],
  failOnNew = false,
): RunResult {
  return {
    schemaVersion: 1,
    tool: { name: 'buttonmash', version: '0.5.0' },
    run: {
      id: 'ci',
      startedAt: '2026-11-10T00:00:00.000Z',
      finishedAt: '2026-11-10T00:00:01.000Z',
      durationMs: 1000,
      target: 'https://example.test',
      browser: 'chromium',
      viewport: { width: 1280, height: 800 },
      exitCode: 0,
      dryRun: false,
      complete: true,
      ...run,
    },
    config: { seed: 'ci', maxActions: 10, maxDurationMs: 1000, failOn: 'high', failOnNew },
    stats: {
      actionsTaken: 1,
      pagesVisited: 1,
      statesDiscovered: 1,
      recordsCreated: 0,
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    actions: [],
    findings,
  };
}

const stop = (kind: RunStop['kind'], reason: string, pagesQueued = 0): RunStop => ({
  kind,
  reason,
  pagesQueued,
});

describe('verdictOf', () => {
  it('passes a clean run and names the threshold', () => {
    expect(verdictOf(result({}, [finding('low')]))).toEqual({
      state: 'passed',
      label: 'PASSED',
      detail: 'No findings at or above high',
      failing: 0,
    });
  });

  it('counts only the findings that fail the build', () => {
    const verdict = verdictOf(
      result({ exitCode: 1 }, [finding('critical'), finding('high'), finding('medium')]),
    );
    expect(verdict.label).toBe('FAILED');
    expect(verdict.detail).toBe('2 findings at or above high');
    expect(verdict.failing).toBe(2);
  });

  it('counts only new findings under failOnNew', () => {
    const verdict = verdictOf(
      result({ exitCode: 1 }, [finding('high', 'new'), finding('high', 'existing')], true),
    );
    expect(verdict.detail).toBe('1 new finding at or above high');
    expect(verdictOf(result({}, [finding('high', 'existing')], true)).detail).toBe(
      'No new findings at or above high',
    );
  });

  it('says why a run that found nothing still failed', () => {
    const verdict = verdictOf(
      result({
        exitCode: 1,
        complete: false,
        stop: stop('session-expired', 'session expired'),
      }),
    );
    expect(verdict.detail).toBe('Stopped early: session expired');
  });

  it('gives both reasons when an early stop also has failing findings', () => {
    const verdict = verdictOf(
      result(
        {
          exitCode: 1,
          complete: false,
          stop: stop('target-unreachable', 'could not load the target (refused)'),
        },
        [finding('critical')],
      ),
    );
    expect(verdict.detail).toBe(
      'Stopped early: could not load the target (refused). 1 finding at or above high',
    );
  });

  it('calls exit 2 an error with partial results, not a failure', () => {
    const verdict = verdictOf(
      result({ exitCode: 2, complete: false, stop: stop('aborted', 'aborted (received SIGINT)') }),
    );
    expect(verdict).toMatchObject({
      state: 'error',
      label: 'ERROR',
      detail: 'Partial results: aborted (received SIGINT)',
    });
  });

  it('still reads results written before run.stop existed', () => {
    expect(verdictOf(result({ exitCode: 2, complete: false })).detail).toBe(
      'Partial results: the run was interrupted or hit a tool error',
    );
    expect(verdictOf(result({ exitCode: 1, complete: false })).detail).toBe(
      'Stopped early: the run did not complete',
    );
  });
});

describe('stopSummary', () => {
  it('adds the pages the crawl found but did not reach', () => {
    expect(stopSummary(stop('time-budget', 'time budget reached (300s)', 14))).toBe(
      'time budget reached (300s), 14 pages still queued',
    );
    expect(stopSummary(stop('action-budget', 'action budget reached (500 actions)', 1))).toBe(
      'action budget reached (500 actions), 1 page still queued',
    );
    expect(stopSummary(stop('crawl-complete', 'crawl complete, no more pages to visit'))).toBe(
      'crawl complete, no more pages to visit',
    );
  });
});
