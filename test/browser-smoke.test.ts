import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buttonmash } from '../src/index';
import type { RunResult } from '../src/core/types';
import type { Engine } from '../src/session/browser';
import { startServer, type TestServer } from './helpers/server';

const requestedBrowser = process.env.BUTTONMASH_SMOKE_BROWSER;
const browser = ['chromium', 'firefox', 'webkit'].includes(requestedBrowser ?? '')
  ? (requestedBrowser as Engine)
  : undefined;

describe.skipIf(!browser)('cross-browser runner smoke', () => {
  let server: TestServer;
  let outDir: string;
  let result: RunResult;

  beforeAll(async () => {
    server = await startServer();
    outDir = mkdtempSync(join(tmpdir(), `buttonmash-${browser}-smoke-`));
    result = await buttonmash({
      target: server.url,
      browser,
      seed: `${browser}-smoke`,
      headless: true,
      logLevel: 'silent',
      budget: { maxActions: 12, maxDurationMs: 30_000, throttleMs: 0 },
      report: {
        outDir,
        formats: ['json'],
        github: false,
        captureScreenshots: false,
        captureTrace: false,
      },
    });
  }, 150_000);

  afterAll(async () => {
    await server?.close();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('launches the requested engine and completes a bounded same-origin run', () => {
    expect(result.run.browser).toBe(browser);
    expect(result.run.complete).toBe(true);
    expect(result.stats.pagesVisited).toBeGreaterThan(0);
    expect(result.stats.actionsTaken).toBeGreaterThan(0);
    expect(result.actions.every((action) => action.url.startsWith(server.url))).toBe(true);
    expect(existsSync(join(outDir, 'results.json'))).toBe(true);
  });
});
