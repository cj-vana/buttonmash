import { describe, expect, it } from 'vitest';

import { replayOverrides, reproduceCommand } from '../src/cli-program';
import { deepMerge, loadConfig } from '../src/config/load';
import type { Config } from '../src/config/schema';
import { EXIT, type RunResult } from '../src/core/types';
import { finalizeRun } from '../src/explorer/run-result';

/** A results.json as a run writes it: finalized, with the config redacted. */
async function recorded(overrides: Config): Promise<RunResult> {
  const cfg = await loadConfig({ ignoreConfigFile: true, overrides });
  const result = finalizeRun({
    cfg,
    startedAt: new Date(),
    startTimeMs: Date.now(),
    signals: [],
    actions: [],
    screenshots: new Map(),
    pagesVisited: 1,
    statesDiscovered: 1,
    recordsCreated: 0,
    completion: { complete: true, incompleteExitCode: EXIT.FINDINGS },
  });
  return JSON.parse(JSON.stringify(result)) as RunResult;
}

const staging = {
  target: 'https://staging.example.test/app',
  seed: 'ci',
  routes: ['/deep/editor?tab=2', 'https://api.example.test/status'],
  headers: { Authorization: 'Bearer t0k3n' },
  auth: {
    storageState: 'playwright/.auth/user.json',
    basicAuth: { username: 'proxy', password: 'proxy-pass' },
    loginScript: {
      url: '/login',
      usernameSelector: '#u',
      passwordSelector: '#p',
      username: 'admin',
      password: 'hunter2',
    },
    loginUrlPattern: '^/account/enter',
  },
  budget: { maxActions: 77, maxDurationMs: 45_000 },
  explore: { forms: { enabled: false } },
  guardrails: {
    dryRun: true,
    allowedOrigins: ['https://cdn.example.test'],
    billing: { mode: 'warn' },
  },
  detectors: { a11y: true },
  baseline: { path: 'previous.json', failOnNew: true, identity: 'staging-admin' },
  report: { outDir: '/ci/workspace/report', formats: ['json', 'sarif'] },
  failOn: 'medium',
} satisfies Config;

describe('replayOverrides', () => {
  it('carries the recorded run settings', async () => {
    const overrides = replayOverrides(await recorded(staging));

    expect(overrides.guardrails?.dryRun).toBe(true);
    expect(overrides.guardrails?.billing?.mode).toBe('warn');
    expect(overrides.budget).toMatchObject({ maxActions: 77, maxDurationMs: 45_000 });
    expect(overrides.explore?.forms?.enabled).toBe(false);
    expect(overrides.detectors?.a11y).toBe(true);
    expect(overrides.report?.formats).toEqual(['json', 'sarif']);
    expect(overrides.failOn).toBe('medium');
    expect(overrides.auth).toEqual({ loginUrlPattern: '^/account/enter' });
  });

  it('drops every value redactedConfig masks, and the run-specific paths', async () => {
    const overrides = replayOverrides(await recorded(staging));
    const text = JSON.stringify(overrides);

    for (const masked of ['***', '<storageState>', '<baseline>', 't0k3n', 'hunter2']) {
      expect(text).not.toContain(masked);
    }
    expect(text).not.toContain('/ci/workspace/report');
    expect(overrides).not.toHaveProperty('target');
    expect(overrides).not.toHaveProperty('seed');
    expect(overrides).not.toHaveProperty('headers');
    expect(overrides).not.toHaveProperty('baseline');
    expect(overrides).not.toHaveProperty('configPath');
    // The resolved captureTrace is not what the user set; a replay that adds
    // --auth must fall back to the credential-safe default.
    expect(overrides.report).not.toHaveProperty('captureTrace');
  });

  it('keeps a replay against another URL off the recorded host', async () => {
    const overrides = replayOverrides(await recorded(staging));
    expect(overrides.routes).toEqual(['/deep/editor?tab=2', 'https://api.example.test/status']);
    expect(overrides.guardrails?.allowedOrigins).not.toContain('https://staging.example.test');

    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: deepMerge<Config>(overrides, { target: 'http://localhost:3000', seed: 'ci' }),
    });
    expect(cfg.routes).toEqual([
      'http://localhost:3000/deep/editor?tab=2',
      'https://api.example.test/status',
    ]);
    expect(cfg.guardrails.allowedOrigins.sort()).toEqual([
      'http://localhost:3000',
      'https://api.example.test',
      'https://cdn.example.test',
    ]);
    expect(cfg.guardrails.dryRun).toBe(true);
    expect(cfg.auth.storageState).toBeUndefined();
    expect(cfg.headers).toEqual({});
  });

  it('lets command-line flags beat the recorded config', async () => {
    const overrides = replayOverrides(await recorded(staging));
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: deepMerge<Config>(overrides, {
        target: 'https://staging.example.test/app',
        seed: 'ci',
        budget: { maxActions: 5 },
        auth: { storageState: 'other.json' },
      }),
    });
    expect(cfg.budget.maxActions).toBe(5);
    expect(cfg.budget.maxDurationMs).toBe(45_000);
    expect(cfg.auth.storageState).toBe('other.json');
    expect(cfg.auth.loginUrlPattern).toBe('^/account/enter');
  });

  it('does not replay a silenced log level, which replay has no flag to undo', async () => {
    const overrides = replayOverrides(await recorded({ ...staging, logLevel: 'silent' }));
    expect(overrides).not.toHaveProperty('logLevel');
  });

  it('returns nothing to replay from a results.json without resolvedConfig', async () => {
    const { resolvedConfig: _omitted, ...older } = await recorded(staging);
    expect(replayOverrides(older as RunResult)).toEqual({});
  });
});

describe('reproduceCommand', () => {
  it('includes --dry-run when the run was read-only', async () => {
    expect(reproduceCommand(await recorded(staging))).toBe(
      'buttonmash run https://staging.example.test/app --seed ci --dry-run',
    );
    const live = await recorded({ target: 'https://x.test', seed: 's' });
    expect(reproduceCommand(live)).toBe('buttonmash run https://x.test --seed s');
  });
});
