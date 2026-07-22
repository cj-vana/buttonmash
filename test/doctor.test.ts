import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/load';
import { runDoctor } from '../src/doctor';
import { startServer, type TestServer } from './helpers/server';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.close();
});

async function config(target: string, overrides = {}) {
  return loadConfig({
    ignoreConfigFile: true,
    overrides: {
      target,
      logLevel: 'silent',
      budget: { actionTimeoutMs: 5_000 },
      report: { captureScreenshots: false, captureTrace: false },
      ...overrides,
    },
  });
}

describe('doctor preflight', () => {
  it('validates a public target without entering the exploration loop', async () => {
    const result = await runDoctor(await config(server.url));

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'browser', status: 'pass' }),
        expect.objectContaining({ id: 'target', status: 'pass' }),
        expect.objectContaining({ id: 'origin', status: 'pass' }),
        expect.objectContaining({ id: 'auth', status: 'pass' }),
        expect.objectContaining({ id: 'billing', status: 'pass' }),
      ]),
    );
  });

  it('executes and verifies a configured login script', async () => {
    const result = await runDoctor(
      await config(`${server.url}/app`, {
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
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'auth', status: 'pass' }));
  });

  it('fails preflight when refuse mode sees a live billing key', async () => {
    const result = await runDoctor(await config(`${server.url}/live-billing`));

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'billing', status: 'fail' }),
    );
  });

  it('honors billing off without scanning live-mode evidence', async () => {
    const result = await runDoctor(
      await config(`${server.url}/live-billing`, {
        guardrails: { billing: { mode: 'off' } },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: 'billing',
        status: 'pass',
        detail: expect.stringContaining('disabled'),
      }),
    );
  });

  it('rejects an off-origin login script before submitting credentials', async () => {
    const result = await runDoctor(
      await config(`${server.url}/app`, {
        auth: {
          loginScript: {
            url: 'https://example.com/login',
            usernameSelector: '#user',
            passwordSelector: '#pass',
            username: 'u',
            password: 'p',
          },
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: 'auth',
        status: 'fail',
        detail: expect.stringContaining('same-origin'),
      }),
    );
  });
});
