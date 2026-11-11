import { beforeEach, describe, expect, it } from 'vitest';

import { baselineComparisonKey, type BaselineSnapshot } from '../src/baseline';
import { loadConfig, type ResolvedConfig } from '../src/config/load';
import { EXIT, type Signal } from '../src/core/types';
import { finalizeRun, type FinalizeRunInput } from '../src/explorer/run-result';
import { version } from '../src/version';

let cfg: ResolvedConfig;

beforeEach(async () => {
  cfg = await loadConfig({
    ignoreConfigFile: true,
    overrides: {
      target: 'https://app.test',
      seed: 'result-test',
      headers: { authorization: 'Bearer secret' },
      auth: {
        storageState: '/tmp/auth.json',
        basicAuth: { username: 'user', password: 'pass' },
        loginScript: {
          url: '/login',
          usernameSelector: '#user',
          passwordSelector: '#pass',
          username: 'alice',
          password: 'secret',
        },
      },
      baseline: { path: '/tmp/baseline.json' },
    },
  });
  cfg.configPath = '/tmp/buttonmash.config.ts';
});

function input(overrides: Partial<FinalizeRunInput> = {}): FinalizeRunInput {
  return {
    cfg,
    startedAt: new Date(),
    startTimeMs: Date.now(),
    signals: [],
    actions: [],
    screenshots: new Map(),
    pagesVisited: 2,
    statesDiscovered: 3,
    recordsCreated: 1,
    completion: {
      complete: true,
      incompleteExitCode: EXIT.ERROR,
    },
    ...overrides,
  };
}

describe('run result finalization', () => {
  it('returns a clean exit for a completed run with no failing findings', () => {
    const result = finalizeRun(input());

    expect(result.run.complete).toBe(true);
    expect(result.run.exitCode).toBe(EXIT.CLEAN);
    expect(result.findings).toHaveLength(0);
  });

  it('aggregates findings, attaches traces, and redacts config without mutating it', () => {
    const signal: Signal = {
      kind: 'pageerror',
      detail: 'boom',
      url: 'https://app.test/projects',
      at: Date.now(),
    };
    const result = finalizeRun(input({ signals: [signal], tracePath: 'artifacts/trace.zip' }));

    expect(result.run.exitCode).toBe(EXIT.FINDINGS);
    expect(result.run.complete).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.artifacts[0]?.path).toBe('artifacts/trace.zip');
    expect(result.stats.findingsBySeverity.high).toBe(1);
    expect(result.resolvedConfig).toMatchObject({
      headers: { authorization: '***' },
      auth: {
        storageState: '<storageState>',
        basicAuth: { username: '***', password: '***' },
        loginScript: { username: '***', password: '***' },
      },
      baseline: { path: '<baseline>' },
    });
    expect(result.resolvedConfig).not.toHaveProperty('configPath');
    expect(cfg.auth.loginScript?.password).toBe('secret');
  });

  it('records why the run stopped and what each visited page saw', () => {
    const at = Date.now();
    const signal: Signal = { kind: 'pageerror', detail: 'boom', url: 'https://app.test/b', at };
    const action = (step: number, url: string) => ({
      step,
      kind: 'click' as const,
      stateHash: 's',
      url,
      ts: at,
    });
    const stop = {
      kind: 'time-budget' as const,
      reason: 'time budget reached (5s)',
      pagesQueued: 2,
    };
    const result = finalizeRun(
      input({
        signals: [signal],
        // An anchor and a cache-buster are the same page as far as the crawl goes.
        actions: [
          action(0, 'https://app.test/a'),
          action(1, 'https://app.test/a#top'),
          action(2, 'https://app.test/b?_=1'),
        ],
        pages: ['https://app.test/a', 'https://app.test/b', 'https://app.test/c'],
        stop,
      }),
    );

    expect(result.run.stop).toEqual(stop);
    expect(result.pages).toEqual([
      { url: 'https://app.test/a', actions: 2, findings: 0 },
      { url: 'https://app.test/b', actions: 1, findings: 1 },
      { url: 'https://app.test/c', actions: 0, findings: 0 },
    ]);
  });

  it('marks abnormal truncation incomplete and returns the tool-error exit code', () => {
    const result = finalizeRun(
      input({
        completion: {
          complete: false,
          incompleteExitCode: EXIT.ERROR,
        },
      }),
    );

    expect(result.run.complete).toBe(false);
    expect(result.run.exitCode).toBe(EXIT.ERROR);
  });

  it('keeps incomplete safety runs at exit 1 when every finding is existing', () => {
    cfg.baseline.failOnNew = true;
    const signal: Signal = {
      kind: 'session-lost',
      detail: 'redirected to login',
      url: 'https://app.test/login',
      at: Date.now(),
    };
    const initial = finalizeRun(input({ signals: [signal] }));
    const known = initial.findings[0]!;
    const baseline: BaselineSnapshot = {
      source: 'baseline.json',
      findings: [
        {
          dedupKey: known.dedupKey,
          severity: known.severity,
          category: known.category,
          title: known.title,
          location: known.location,
        },
      ],
      complete: true,
      toolVersion: version,
      comparisonKey: baselineComparisonKey(cfg),
    };

    const result = finalizeRun(
      input({
        baseline,
        signals: [signal],
        completion: { complete: false, incompleteExitCode: EXIT.FINDINGS },
      }),
    );
    expect(result.findings[0]?.baselineState).toBe('existing');
    expect(result.run.complete).toBe(false);
    expect(result.run.exitCode).toBe(EXIT.FINDINGS);
  });

  it('preserves an incomplete safety verdict when a finding is independently failing', () => {
    const signal: Signal = {
      kind: 'crash',
      detail: 'renderer crashed',
      url: 'https://app.test/projects',
      at: Date.now(),
    };
    const result = finalizeRun(
      input({
        signals: [signal],
        completion: { complete: false, incompleteExitCode: EXIT.FINDINGS },
      }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.run.exitCode).toBe(EXIT.FINDINGS);
  });
});
