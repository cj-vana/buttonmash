/**
 * Authentication via Playwright storageState. The recommended flow is to run
 * `buttonmash auth <login-url>` once: it opens a real (headed) browser, you log
 * in by hand, press Enter, and the cookies + localStorage are saved to a JSON
 * file that runs reuse. The file holds secrets — keep it out of version control.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { logger } from '../core/logger';
import { launchBrowser, type Engine } from './browser';

/** Validate that a storageState file exists and looks like one. Warn, don't throw. */
export async function validateStorageState(path: string): Promise<boolean> {
  if (!existsSync(path)) {
    logger.warn(`Auth file not found: ${path} — running unauthenticated.`);
    return false;
  }
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as {
      cookies?: unknown[];
      origins?: unknown[];
    };
    if (!Array.isArray(data.cookies) && !Array.isArray(data.origins)) {
      logger.warn(`Auth file ${path} does not look like a Playwright storageState.`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`Could not read auth file ${path}: ${(err as Error).message}`);
    return false;
  }
}

export interface LoginScript {
  url: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector?: string;
  username: string;
  password: string;
  successUrl?: string;
  successSelector?: string;
}

/**
 * Log in by driving the login form (CI-friendly; reused on session drop).
 * `url` should already be absolute. Returns true if it appears to have left
 * the login page. Never logs the password.
 */
export async function performScriptedLogin(
  page: import('playwright').Page,
  ls: LoginScript,
  timeoutMs: number,
): Promise<boolean> {
  await page.goto(ls.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
  try {
    await page.fill(ls.usernameSelector, ls.username, { timeout: timeoutMs });
    await page.fill(ls.passwordSelector, ls.password, { timeout: timeoutMs });
    if (ls.submitSelector) {
      await page.click(ls.submitSelector, { timeout: timeoutMs });
    } else {
      await page.press(ls.passwordSelector, 'Enter', { timeout: timeoutMs });
    }
  } catch (err) {
    logger.warn(`Login form interaction failed: ${(err as Error).message}`);
    return false;
  }
  if (ls.successUrl) {
    await page.waitForURL(new RegExp(ls.successUrl), { timeout: timeoutMs }).catch(() => {});
  } else if (ls.successSelector) {
    await page
      .locator(ls.successSelector)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .catch(() => {});
  } else {
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  }
  return true;
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Open a headed browser at `url`, let the user log in, then save storageState
 * to `outPath`.
 */
export async function captureAuth(url: string, outPath: string, engine: Engine): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  logger.banner('buttonmash auth');
  logger.info(`Opening ${engine} at ${url} …`);
  const browser = await launchBrowser(engine, false);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    logger.info('');
    logger.info('  → Log in to the app in the browser window that just opened.');
    logger.info('  → When you are fully logged in, come back here and press Enter.');
    logger.info('');
    await waitForEnter('Press Enter to save the session… ');
    await context.storageState({ path: outPath });
    logger.success(`Saved session to ${outPath}`);
    logger.warn('This file contains cookies/tokens. Do NOT commit it (already gitignored).');
    await context.close();
  } finally {
    await browser.close();
  }
}
