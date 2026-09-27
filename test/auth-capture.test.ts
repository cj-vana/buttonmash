/** `buttonmash auth` without a real browser or keyboard: the browser is a fake
 *  and Enter is pressed as soon as the prompt appears. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../src/core/logger';
import { captureAuth } from '../src/session/auth';

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, answer: (line: string) => void) => answer(''),
    close: () => {},
  }),
}));

vi.mock('../src/session/browser', () => ({
  launchBrowser: async () => ({
    newContext: async () => ({
      newPage: async () => ({ goto: async () => null }),
      storageState: async () => ({ cookies: [], origins: [] }),
      close: async () => {},
    }),
    close: async () => {},
  }),
}));

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('captureAuth', () => {
  it('tells the user to gitignore the saved session instead of claiming it already is', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'banner').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-auth-'));
    directories.push(directory);
    const out = join(directory, 'session', 'user.json');

    await captureAuth('https://x.test/login', out, 'chromium');

    const warnings = warn.mock.calls.map(([message]) => message).join('\n');
    expect(warnings).not.toContain('already gitignored');
    expect(warnings).toContain('.gitignore');
    expect(warnings).toContain(out);
  });
});
