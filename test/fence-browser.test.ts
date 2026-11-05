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
import { aggregateFindings } from '../src/detectors/aggregate';
import { SignalRecorder } from '../src/detectors/recorder';
import { DANGEROUS_PATH_RE } from '../src/guardrails/destructive';
import {
  FenceLog,
  attachPageFence,
  compileRequestRules,
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

describe('blockedRequests', () => {
  /** Send `method` to `path` from the page, as an app's fetch would. */
  const send = (method: string, path: string) =>
    page.evaluate(
      ([m, p]) =>
        fetch(p as string, { method: m as string }).then(
          () => 'sent',
          () => 'refused',
        ),
      [method, path],
    );
  const fenceNotes = () => recorder.signals.filter((s) => s.kind === 'fence').map((s) => s.detail);

  it('refuses a method on a path while a read of the same path goes through', async () => {
    await setUp({ blockedRequests: compileRequestRules([{ method: 'delete' }]) });
    expect(await send('DELETE', '/api/workspace')).toBe('refused');
    expect(await send('GET', '/api/workspace')).toBe('sent');
    expect(requested()).toEqual([`GET 127.0.0.1:${port}/api/workspace`]);
    expect(fenceNotes()).toEqual([`DELETE ${base}/api/workspace (guardrails.blockedRequests[0])`]);
  });

  it('refuses a method the page sends in lower case', async () => {
    // fetch() upper-cases only the standard methods, so this goes out as
    // "patch", which servers commonly route as PATCH.
    await setUp({ blockedRequests: compileRequestRules([{ method: 'PATCH' }]) });
    expect(await send('patch', '/api/workspace')).toBe('refused');
    expect(requested()).toEqual([]);
    expect(fenceNotes()).toEqual([`patch ${base}/api/workspace (guardrails.blockedRequests[0])`]);
  });

  it('needs both the method and the path when a rule has both', async () => {
    await setUp({
      blockedRequests: compileRequestRules([{ method: 'POST', path: '^/api/admin/' }]),
    });
    expect(await send('POST', '/api/admin/users')).toBe('refused');
    expect(await send('GET', '/api/admin/users')).toBe('sent');
    expect(await send('POST', '/api/notes')).toBe('sent');
    expect(requested()).toEqual([
      `GET 127.0.0.1:${port}/api/admin/users`,
      `POST 127.0.0.1:${port}/api/notes`,
    ]);
  });

  it('closes a socket whose handshake a path rule refuses', async () => {
    await setUp({ blockedRequests: compileRequestRules([{ path: '^/live' }]) });
    const ended = await page.evaluate(
      (target) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(target);
          ws.onclose = (event) => resolve(`closed ${event.code}`);
          setTimeout(() => resolve('pending'), 2_000);
        }),
      `ws://127.0.0.1:${port}/live`,
    );
    expect(ended).toBe('closed 1008');
    await settle();
    expect(requested()).toEqual([]);
    expect(fenceNotes()).toEqual([
      `WebSocket ws://127.0.0.1:${port}/live (guardrails.blockedRequests[0])`,
    ]);
  });

  it('reports blocked paths and page loads from other origins, not media blocking', async () => {
    await setUp({ blockMedia: true });
    expect(await send('POST', '/logout')).toBe('refused');
    await page.evaluate(() => new FontFace('brand', 'url(/brand.woff2)').load().catch(() => {}));
    await expect(page.goto(`${offsite}/elsewhere`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    await settle();
    expect(fenced.has(`${base}/brand.woff2`)).toBe(true);
    expect(fenceNotes()).toEqual([
      `POST ${base}/logout (blocked path)`,
      `page load from ${offsite}, outside the allowed origins`,
    ]);
  });

  it('groups blocks of one route from different pages into one finding', async () => {
    await setUp({ blockedRequests: compileRequestRules([{ method: 'DELETE' }]) });
    for (const from of ['/start', '/other']) {
      await page.goto(`${base}${from}`);
      recorder.setContext(0, page.url());
      await send('DELETE', '/api/things/48213');
      await send('DELETE', '/api/things/59724');
    }
    const findings = aggregateFindings({
      signals: recorder.signals,
      actions: [],
      screenshots: new Map(),
    });
    expect(findings.map((f) => [f.category, f.severity, f.count])).toEqual([['fence', 'info', 4]]);
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
