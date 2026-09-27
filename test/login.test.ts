/**
 * Integration test: scripted login. performScriptedLogin drives a cookie-gated
 * login form, and a full run uses it to reach an otherwise-redirected app.
 * Requires Chromium.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger } from '../src/core/logger';
import { performScriptedLogin } from '../src/session/auth';
import { buttonmash } from '../src/index';
import { startServer, type TestServer } from './helpers/server';

let server: TestServer;
let browser: Browser;

beforeAll(async () => {
  server = await startServer();
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const script = (origin: string) => ({
  url: `${origin}/login`,
  usernameSelector: '#user',
  passwordSelector: '#pass',
  submitSelector: '#go',
  username: 'u',
  password: 'p',
  successUrl: '/app',
});

describe('scripted login', () => {
  it('performScriptedLogin signs in and lands on the gated app', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // unauthenticated /app redirects to /login
    await page.goto(`${server.url}/app`, { waitUntil: 'domcontentloaded' });
    expect(page.url()).toContain('/login');

    const ok = await performScriptedLogin(page, script(server.url), 10_000);
    expect(ok).toBe(true);
    expect(page.url()).toContain('/app');
    await ctx.close();
  }, 30_000);

  it('returns false and says which success condition was not reached', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const password = 'pw-must-not-be-logged';
      const badUrl = { ...script(server.url), password, successUrl: '/never' };
      expect(await performScriptedLogin(page, badUrl, 500)).toBe(false);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('successUrl /never'));

      const badSelector = { ...badUrl, successUrl: undefined, successSelector: '#nope' };
      expect(await performScriptedLogin(page, badSelector, 500)).toBe(false);
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('successSelector #nope'));

      expect(warn.mock.calls.flat().join('\n')).not.toContain(password);
    } finally {
      warn.mockRestore();
      await ctx.close();
    }
  });

  it('a full run uses the login script to reach the gated app', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'bm-login-'));
    try {
      const result = await buttonmash({
        target: `${server.url}/app`,
        auth: {
          loginScript: {
            url: '/login',
            usernameSelector: '#user',
            passwordSelector: '#pass',
            submitSelector: '#go',
            username: 'u',
            password: 'p',
            successUrl: '/app',
          },
        },
        headless: true,
        logLevel: 'silent',
        budget: { maxActions: 40, maxDurationMs: 30_000, throttleMs: 20 },
        report: {
          outDir,
          formats: ['json'],
          github: false,
          captureScreenshots: false,
          captureTrace: false,
        },
      });
      // It logged in and explored the protected app rather than being stuck on
      // /login. (A transient session-lost + re-auth is acceptable behavior — the
      // guarantee is that the login script gets it INTO the gated app.)
      expect(result.actions.some((a) => /\/app(\/|$|\?|#)/.test(a.url))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
