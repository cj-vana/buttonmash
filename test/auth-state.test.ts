import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger } from '../src/core/logger';
import { validateStorageState } from '../src/session/auth';

let dir: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buttonmash-auth-state-'));
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('storage state validation', () => {
  it('accepts Playwright cookie or origin arrays', async () => {
    const cookies = join(dir, 'cookies.json');
    const origins = join(dir, 'origins.json');
    writeFileSync(cookies, JSON.stringify({ cookies: [] }));
    writeFileSync(origins, JSON.stringify({ origins: [] }));
    await expect(validateStorageState(cookies)).resolves.toBe(true);
    await expect(validateStorageState(origins)).resolves.toBe(true);
  });

  it('rejects missing, malformed, and unrelated files', async () => {
    const malformed = join(dir, 'malformed.json');
    const unrelated = join(dir, 'unrelated.json');
    writeFileSync(malformed, '{');
    writeFileSync(unrelated, JSON.stringify({ session: 'token' }));
    await expect(validateStorageState(join(dir, 'missing.json'))).resolves.toBe(false);
    await expect(validateStorageState(malformed)).resolves.toBe(false);
    await expect(validateStorageState(unrelated)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('Auth file not found'),
      expect.stringContaining('Could not read auth file'),
      expect.stringContaining('does not look like a Playwright storageState'),
    ]);
  });
});
