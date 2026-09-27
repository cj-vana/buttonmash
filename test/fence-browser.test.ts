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
    const redirect = (location: string, headers: Record<string, string> = {}) => {
      res.writeHead(302, { location, ...headers });
      res.end();
    };
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/bounce') return redirect('/logout');
    if (path === '/redir-off') return redirect(`${offsite}/offsite`);
    if (path === '/hop1') return redirect('/hop2');
    if (path === '/hop2') return redirect('/home');
    if (path === '/session' && req.method === 'POST') {
      return redirect('/home', { 'set-cookie': 'sid=abc; Path=/; HttpOnly' });
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // Every page pings the server from script, so a page that loaded and ran
    // shows up in `hits` as a second request.
    res.end(
      `<!doctype html><title>${req.url}</title><p>${req.url}</p>` +
        (path === '/offsite' ? "<script>fetch('/offsite-script-ran')</script>" : ''),
    );
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

/** A fresh context with the fence installed, and a page on /start. */
async function setUp(overrides: Partial<FenceOptions> = {}): Promise<void> {
  await context?.close();
  context = await browser.newContext({ serviceWorkers: 'block' });
  recorder = new SignalRecorder();
  fenced = new FenceLog();
  const opts: FenceOptions = {
    allowedOrigins: [base],
    // A user pattern anchored on the pathname, next to the built-in one.
    blockedPathRe: combineRegexes([DANGEROUS_PATH_RE, /^\/admin$/]),
    blockMedia: false,
    billingMode: 'refuse',
    isBillingLatched: () => false,
    aborted: fenced,
    ...overrides,
  };
  page = await context.newPage();
  await installContextFence(context, opts, recorder);
  attachPageFence(page, opts, recorder);
  await page.goto(`${base}/start`);
  hits.length = 0;
}

beforeEach(() => setUp());

const settle = () => page.waitForTimeout(400);
/** `hits` without the cookie column: "GET 127.0.0.1:PORT/path". */
const requested = () => hits.map((h) => h.split(' ').slice(0, 2).join(' '));
const guardrailNotes = () =>
  recorder.signals.filter((s) => s.kind === 'guardrail').map((s) => s.detail);

describe('redirects by default', () => {
  it('are followed by the browser unchecked', async () => {
    await page.goto(`${base}/hop1`);
    expect(page.url()).toBe(`${base}/home`);
    expect(fenced.has(`${base}/hop1`)).toBe(false);
  });
});

describe('redirects with vetRedirects', () => {
  beforeEach(() => setUp({ vetRedirects: true }));

  it('blocks a same-origin redirect to a dangerous path', async () => {
    await expect(page.goto(`${base}/bounce`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    await settle();
    expect(requested()).toEqual([`GET 127.0.0.1:${port}/bounce`]);
    expect(fenced.has(`${base}/bounce`)).toBe(true);
  });

  it('blocks a redirect to an off-origin document before it loads', async () => {
    await page.evaluate(() => {
      location.href = '/redir-off';
    });
    await settle();
    expect(requested()).toEqual([`GET 127.0.0.1:${port}/redir-off`]);
    expect(guardrailNotes()).toEqual([]);
  });

  it('follows a login redirect that sets a cookie, and lands on its target', async () => {
    await Promise.all([
      page.waitForURL(`${base}/home`),
      page.evaluate(() => {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = '/session';
        document.body.append(form);
        form.submit();
      }),
    ]);
    expect(hits).toEqual([
      `POST 127.0.0.1:${port}/session cookie=`,
      `GET 127.0.0.1:${port}/home cookie=sid=abc`,
    ]);
    expect((await context.cookies()).map((c) => c.name)).toEqual(['sid']);
  });

  it('lands on the last page of a safe redirect chain', async () => {
    await page.goto(`${base}/hop1`);
    expect(page.url()).toBe(`${base}/home`);
    expect(requested()).toEqual([
      `GET 127.0.0.1:${port}/hop1`,
      `GET 127.0.0.1:${port}/hop2`,
      `GET 127.0.0.1:${port}/home`,
    ]);
  });
});

describe('WebSockets', () => {
  /** Open a socket from the page and report how it ended. */
  const openSocket = (url: string) =>
    page.evaluate(
      (target) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(target);
          ws.onclose = (event) => resolve(`closed ${event.code}`);
          setTimeout(() => resolve('pending'), 2_000);
        }),
      url,
    );

  it('closes a socket to a dangerous path before it reaches the server', async () => {
    const url = `ws://127.0.0.1:${port}/logout`;
    expect(await openSocket(url)).toBe('closed 1008');
    await settle();
    expect(requested()).toEqual([]);
    expect(fenced.has(url)).toBe(true);
  });

  it('lets an ordinary socket connect to the server', async () => {
    await openSocket(`ws://127.0.0.1:${port}/chat`);
    await settle();
    expect(requested()).toEqual([`UPGRADE 127.0.0.1:${port}/chat`]);
  });
});

describe('dangerous routes outside the pathname', () => {
  it('blocks a logout route carried in the query string (OpenCart)', async () => {
    const url = `${base}/index.php?route=account/logout`;
    await expect(page.goto(url)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect(hits).toEqual([]);
    expect(fenced.has(url)).toBe(true);

    await settle(); // Chromium commits its error page after goto rejects
    await page.goto(`${base}/start`);
    hits.length = 0;
    await page.evaluate(() => fetch('/api/session?action=logout').catch(() => {}));
    await settle();
    expect(hits).toEqual([]);
  });

  it('still lets ordinary queries through and still matches anchored patterns', async () => {
    await page.goto(`${base}/search?q=shoes&sort=price`);
    await page.goto(`${base}/admin?tab=users`).catch(() => {});
    expect(hits.map((h) => h.split(' ')[1])).toEqual([
      `127.0.0.1:${port}/search?q=shoes&sort=price`,
    ]);
  });
});

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
