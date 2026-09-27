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
};

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
    target: base + path,
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
