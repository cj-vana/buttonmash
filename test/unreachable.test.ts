/**
 * A control another layer covers makes Playwright wait out the whole
 * interaction timeout. On canvas apps 0.2.0 kept picking the same covered
 * controls, so most of the run's budget went to waiting. Each covered control
 * should cost one timeout per page, not one per pick.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buttonmash } from '../src/index';
import type { RunResult } from '../src/core/types';
import { startServer, type TestServer } from './helpers/server';

const COVERED_BUTTONS = 3;

let server: TestServer;
let outDir: string;
let result: RunResult;

beforeAll(async () => {
  server = await startServer();
  outDir = mkdtempSync(join(tmpdir(), 'buttonmash-unreachable-'));
  result = await buttonmash({
    target: `${server.url}/covered`,
    seed: 'covered',
    headless: true,
    logLevel: 'silent',
    explore: { crawl: false },
    budget: {
      maxActions: 40,
      maxDurationMs: 60_000,
      throttleMs: 10,
      interactionTimeoutMs: 500,
    },
    report: {
      outDir,
      formats: ['json'],
      github: false,
      captureScreenshots: false,
      captureTrace: false,
    },
  });
}, 90_000);

afterAll(async () => {
  await server?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('controls covered by another layer', () => {
  const timeouts = () =>
    result.findings
      .filter((f) => f.category === 'driver-error' && /Timeout \d+ms exceeded/.test(f.description))
      .reduce((sum, f) => sum + f.count, 0);

  it('time out at most once each', () => {
    expect(timeouts()).toBeGreaterThan(0);
    expect(timeouts()).toBeLessThanOrEqual(COVERED_BUTTONS);
  });

  it('end the sweep once nothing on the page is reachable', () => {
    // On this page every loop turn either logs an action or fails one, so
    // reaching the action budget means the monkey kept retrying covered controls.
    expect(result.stats.actionsTaken + timeouts()).toBeLessThan(40);
    expect(result.run.complete).toBe(true);
  });
});
