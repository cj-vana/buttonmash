/**
 * Whole-run behavior of the runner against small inline pages: client-side
 * routes into guarded paths, frozen renderers, broken logins, missing auth
 * files, failed actions in the trace, and pages whose load event never fires.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buttonmash } from '../src/index';
import { ConfigError } from '../src/config/load';
import type { Config } from '../src/config/schema';

/** Matches the github-pat rule: ghp_ plus 36 alphanumerics. */
const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;

const PAGES: Record<string, string> = {
  '/spa':
    '<h1>Dashboard</h1><button id="go">Settings</button>' +
    '<script>document.getElementById("go").onclick = () => {' +
    'history.pushState({}, "", "/admin");' +
    'document.body.innerHTML = "<button id=\'rebuild\'>Rebuild index</button>";' +
    'document.getElementById("rebuild").onclick = () => fetch("/api/rebuild", { method: "POST" });' +
    '};</script>',
  '/freeze': '<button onclick="for(;;){}">Refresh</button>',
  '/login-page': '<form><input id="email"><button>Sign in</button></form>',
  '/covered':
    '<button>Pen</button><button>Hand</button>' +
    '<div style="position:fixed;inset:0;z-index:10"></div>',
  '/slow-load': '<img src="/never.png" alt="stream"><button>One</button><button>Two</button>',
  '/token-dialog': `<button onclick="alert('deploy token ${GITHUB_TOKEN}')">Show token</button>`,
  '/live':
    '<button>Refresh</button><script>new WebSocket("ws://" + location.host + "/feed")</script>',
  '/hub': '<a href="/leaf">Leaf</a><a href="/leaf-two">Second leaf</a><button>Stay</button>',
  '/leaf': '<button>One</button>',
};

const HOVER_ONLY = {
  click: 0,
  dblclick: 0,
  type: 0,
  key: 0,
  hover: 100,
  scroll: 0,
  select: 0,
  check: 0,
  back: 0,
  forward: 0,
  resize: 0,
};

/** A localhost port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const addr = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof addr === 'object' && addr ? addr.port : 0;
}

let server: Server;
let base: string;
const hits: string[] = [];
const outDirs: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (req.method !== 'GET') hits.push(`${req.method} ${path}`);
    if (path === '/never.png') return; // the load event never fires
    const body = PAGES[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ? `<!doctype html><meta charset="utf-8"><body>${body}</body>` : 'no');
  });
  server.on('upgrade', (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

function run(path: string, config: Config = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'buttonmash-runner-'));
  outDirs.push(outDir);
  return buttonmash({
    target: path.startsWith('http') ? path : base + path,
    seed: 'runner',
    headless: true,
    logLevel: 'silent',
    ...config,
    explore: { crawl: false, ...config.explore },
    budget: { maxActions: 20, maxDurationMs: 45_000, throttleMs: 10, ...config.budget },
    report: {
      outDir,
      formats: ['json'],
      github: false,
      captureScreenshots: false,
      captureTrace: false,
    },
  });
}

describe('client-side routes into guarded paths', () => {
  it('are left without acting on them', async () => {
    const result = await run('/spa', {
      guardrails: { excludePaths: ['^/admin'] },
      explore: { weights: { click: 100, dblclick: 0, hover: 0, key: 0, scroll: 0, resize: 0 } },
    });
    expect(hits).not.toContain('POST /api/rebuild');
    expect(result.actions.filter((a) => a.url.endsWith('/admin'))).toEqual([]);
  }, 60_000);
});

describe('a frozen renderer', () => {
  it('is reported as a hang, not a low driver error', async () => {
    const result = await run('/freeze', {
      explore: { weights: { click: 100, dblclick: 0, hover: 0, key: 0, scroll: 0, resize: 0 } },
      budget: { maxActions: 3, readyTimeoutMs: 2_000, interactionTimeoutMs: 2_000 },
    });
    const hang = result.findings.find((f) => f.category === 'hang');
    expect(hang?.severity).toBe('high');
    expect(result.run.exitCode).toBe(1);
  }, 90_000);
});

describe('a scripted login that never authenticates', () => {
  it('ends the run as a failure instead of exploring unauthenticated', async () => {
    const result = await run('/spa', {
      auth: {
        loginScript: {
          url: '/login-page',
          usernameSelector: '#email',
          passwordSelector: '#missing-password-field',
          username: 'qa@example.test',
          password: 'secret',
        },
      },
      budget: { actionTimeoutMs: 2_000 },
    });
    expect(result.run.exitCode).toBe(1);
    expect(result.run.complete).toBe(false);
    expect(result.findings.some((f) => f.category === 'session-lost')).toBe(true);
    expect(result.actions).toEqual([]);
  }, 90_000);
});

describe('a configured auth file that is missing', () => {
  it('is a config error, not a quiet unauthenticated run', async () => {
    await expect(
      run('/spa', { auth: { storageState: join(tmpdir(), 'no-such-dir', 'user.json') } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('actions that fail', () => {
  it('stay in the action log with their error, stamped when they started', async () => {
    const result = await run('/covered', {
      explore: { weights: { click: 100, dblclick: 0, hover: 0, key: 0, scroll: 0, resize: 0 } },
      budget: { interactionTimeoutMs: 500 },
    });
    const failed = result.actions.filter((a) => a.error);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.error).toMatch(/Timeout/);
    const timestamps = result.actions.map((a) => a.ts);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  }, 60_000);
});

describe('redirect vetting', () => {
  it('keeps a localhost page able to open its WebSockets', async () => {
    // Vetting hands Chromium every document through route.fulfill, and Local
    // Network Access then blocks the page's sockets unless the check is off.
    await run('/live', { guardrails: { vetRedirects: true }, budget: { maxActions: 2 } });
    expect(hits).toContain('UPGRADE /feed');
  }, 60_000);
});

describe('a secret shown in a dialog', () => {
  it('reaches the results redacted', async () => {
    expect(GITHUB_TOKEN).toMatch(/^ghp_[0-9a-zA-Z]{36}$/);
    const result = await run('/token-dialog', {
      explore: { weights: { click: 100, dblclick: 0, hover: 0, key: 0, scroll: 0, resize: 0 } },
      budget: { maxActions: 3 },
    });
    const dialog = result.findings.find((f) => f.category === 'dialog');
    expect(dialog).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
  }, 60_000);
});

describe('a page whose load event never fires', () => {
  it('is waited for once per navigation, not before every action', async () => {
    const started = Date.now();
    const result = await run('/slow-load', {
      budget: { maxActions: 8, readyTimeoutMs: 3_000 },
      explore: { weights: { back: 0, forward: 0 } },
    });
    expect(result.actions.length).toBeGreaterThan(4);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});

describe('a target that is not running', () => {
  it('ends the run at once and says why, instead of loading it again', async () => {
    const target = `http://127.0.0.1:${await closedPort()}/`;
    const result = await run(target, { explore: { crawl: true } });
    expect(result.run.stop?.kind).toBe('target-unreachable');
    expect(result.run.stop?.reason).toBe(
      `could not load the target (net::ERR_CONNECTION_REFUSED at ${target})`,
    );
    expect(result.run.exitCode).toBe(1);
    expect(result.run.complete).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.pages).toEqual([]);
    expect(result.stats.pagesVisited).toBe(0);
    const driver = result.findings.filter((f) => f.category === 'driver-error');
    expect(driver.map((f) => [f.severity, f.count])).toEqual([['critical', 1]]);
  }, 60_000);
});

describe('the reason a run stopped', () => {
  it('names the action budget and counts the pages still queued', async () => {
    const result = await run('/hub', {
      explore: { crawl: true, weights: HOVER_ONLY },
      budget: { maxActions: 2 },
    });
    expect(result.run.stop).toEqual({
      kind: 'action-budget',
      reason: 'action budget reached (2 actions)',
      pagesQueued: 2,
    });
    expect(result.run.complete).toBe(true);
    expect(result.pages).toEqual([{ url: `${base}/hub`, actions: 2, findings: 0 }]);
  }, 60_000);

  it('names a sweep that ran out of pages', async () => {
    const result = await run('/leaf', {
      explore: { weights: HOVER_ONLY },
      budget: { maxActions: 400, saturationLimit: 3 },
    });
    expect(result.run.stop?.kind).toBe('crawl-complete');
    expect(result.run.stop?.pagesQueued).toBe(0);
    expect(result.stats.actionsTaken).toBeLessThan(400);
  }, 60_000);
});
