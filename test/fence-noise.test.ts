/**
 * The fence's own aborts must not read as app bugs. Chromium logs
 * `Failed to load resource: net::ERR_BLOCKED_BY_CLIENT` for every request the
 * fence cancels (a web font under blockMedia, a logout ping), and on 0.2.0 that
 * console.error failed the build on apps that had nothing wrong with them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buttonmash } from '../src/index';
import type { RunResult } from '../src/core/types';
import { startServer, type TestServer } from './helpers/server';

let server: TestServer;
let outDir: string;
let result: RunResult;

beforeAll(async () => {
  server = await startServer();
  outDir = mkdtempSync(join(tmpdir(), 'buttonmash-fence-noise-'));
  result = await buttonmash({
    target: `${server.url}/fonts`,
    seed: 'fence-noise',
    headless: true,
    logLevel: 'silent',
    explore: { crawl: false },
    budget: { maxActions: 8, maxDurationMs: 30_000, throttleMs: 30 },
    report: {
      outDir,
      formats: ['json'],
      github: false,
      captureScreenshots: false,
      captureTrace: false,
    },
  });
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('requests the fence aborts', () => {
  it('are not reported as console errors', () => {
    const blocked = result.findings.filter((f) => /BLOCKED_BY_CLIENT/i.test(f.description));
    expect(blocked).toEqual([]);
    expect(result.findings.filter((f) => f.category === 'console-error')).toEqual([]);
  });

  it('leave a clean page passing', () => {
    expect(result.stats.actionsTaken).toBeGreaterThan(0);
    expect(result.run.exitCode).toBe(0);
  });
});
