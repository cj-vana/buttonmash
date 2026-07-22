import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type ResolvedConfig } from '../src/config/load';
import { EXIT, type Signal } from '../src/core/types';
import { finalizeRun, type FinalizeRunInput } from '../src/explorer/run-result';

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
      internalError: false,
    },
    ...overrides,
  };
}

describe('run result finalization', () => {
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

  it('marks abnormal truncation incomplete and returns the tool-error exit code', () => {
    const result = finalizeRun(
      input({
        completion: {
          complete: false,
          internalError: true,
        },
      }),
    );

    expect(result.run.complete).toBe(false);
    expect(result.run.exitCode).toBe(EXIT.ERROR);
  });
});
