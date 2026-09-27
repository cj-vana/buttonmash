/**
 * The network fence in Chromium, against a server that records every request
 * it receives. 127.0.0.1:PORT is the allowed origin; localhost:PORT is the
 * same server under an origin the fence must keep the browser away from.
 * The page is created before the fence is installed, as the runner does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { combineRegexes } from '../src/core/regex';
import { SignalRecorder } from '../src/detectors/recorder';
import { DANGEROUS_PATH_RE } from '../src/guardrails/destructive';
import {
  FenceLog,
  attachPageFence,
  installContextFence,
  type FenceOptions,
} from '../src/guardrails/fence';

let server: Server;
let port = 0;
let base = '';
let offsite = '';
const hits: string[] = [];

let browser: Browser;
let context: BrowserContext;
let page: Page;
let recorder: SignalRecorder;
let fenced: FenceLog;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host}${req.url} cookie=${req.headers.cookie ?? ''}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>${req.url}</title><p>${req.url}</p>`);
  });
  server.on('upgrade', (req, socket) => {
    hits.push(`UPGRADE ${req.headers.host}${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  offsite = `http://localhost:${port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(async () => {
  await context?.close();
  context = await browser.newContext({ serviceWorkers: 'block' });
  recorder = new SignalRecorder();
  fenced = new FenceLog();
  const opts: FenceOptions = {
    allowedOrigins: [base],
    blockedPathRe: combineRegexes([DANGEROUS_PATH_RE]),
    blockMedia: false,
    billingMode: 'refuse',
    isBillingLatched: () => false,
    aborted: fenced,
  };
  page = await context.newPage();
  await installContextFence(context, opts, recorder);
  attachPageFence(page, opts, recorder);
  await page.goto(`${base}/start`);
  hits.length = 0;
});

const settle = () => page.waitForTimeout(400);
const guardrailNotes = () =>
  recorder.signals.filter((s) => s.kind === 'guardrail').map((s) => s.detail);

describe('commits with an opaque origin', () => {
  it('does not report or undo the error page Chromium shows for a fenced navigation', async () => {
    await expect(page.goto(`${offsite}/elsewhere`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    await settle();
    expect(fenced.has(`${offsite}/elsewhere`)).toBe(true);
    expect(guardrailNotes()).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('does not report or undo a step back to about:blank', async () => {
    const fresh = await context.newPage();
    const opts = {
      allowedOrigins: [base],
      blockedPathRe: null,
      blockMedia: false,
      billingMode: 'off' as const,
      isBillingLatched: () => false,
    };
    attachPageFence(fresh, opts, recorder);
    await fresh.goto(`${base}/first`);
    await fresh.goBack();
    await fresh.waitForTimeout(400);
    expect(fresh.url()).toBe('about:blank');
    expect(guardrailNotes()).toEqual([]);
    await fresh.close();
  });

  it('does not report a popup whose off-origin navigation the fence aborted', async () => {
    const popup = context.waitForEvent('page');
    await page.evaluate((url) => void window.open(url), `${offsite}/popup`);
    await (await popup).waitForLoadState().catch(() => {});
    await settle();
    expect(guardrailNotes()).toEqual([]);
    expect(hits).toEqual([]);
  });
});
