/**
 * The fence's own aborts must not read as app bugs. Every engine reports the
 * requests the fence cancels (a web font under blockMedia, a logout ping, an
 * off-origin embed), each in its own words: Chromium as a console.error with
 * `net::ERR_BLOCKED_BY_CLIENT`, Firefox as `NS_ERROR_FAILURE` plus a
 * console.error for a font, WebKit as "Blocked by Web Inspector". On 0.2.0
 * these failed the build on apps that had nothing wrong with them.
 *
 * Runs on Chromium by default; CI's cross-browser jobs set
 * BUTTONMASH_SMOKE_BROWSER to run it on Firefox and WebKit too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buttonmash } from '../src/index';
import type { RunResult } from '../src/core/types';
import type { Engine } from '../src/session/browser';
import { startServer, type TestServer } from './helpers/server';

const requested = process.env.BUTTONMASH_SMOKE_BROWSER;
const browser: Engine = requested === 'firefox' || requested === 'webkit' ? requested : 'chromium';

let server: TestServer;
let outDir: string;
let result: RunResult;

beforeAll(async () => {
  server = await startServer();
  outDir = mkdtempSync(join(tmpdir(), `buttonmash-fence-noise-${browser}-`));
  result = await buttonmash({
    target: `${server.url}/fonts`,
    browser,
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
}, 90_000);

afterAll(async () => {
  await server?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe(`requests the fence aborts (${browser})`, () => {
  it('are not reported as console errors', () => {
    const blocked = result.findings.filter((f) => /BLOCKED_BY_CLIENT/i.test(f.description));
    expect(blocked).toEqual([]);
    expect(result.findings.filter((f) => f.category === 'console-error')).toEqual([]);
  });

  it('are not reported as failed network requests', () => {
    expect(result.findings.filter((f) => f.category === 'network')).toEqual([]);
  });

  it('leave a clean page passing', () => {
    expect(result.stats.actionsTaken).toBeGreaterThan(0);
    expect(result.run.exitCode).toBe(0);
  });
});
