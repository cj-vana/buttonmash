/**
 * Browser + context lifecycle. We use the Playwright *library* (not the test
 * runner) so we own the loop and teardown. The context is configured for
 * stability and reproducibility: fixed viewport/locale/timezone, reduced
 * motion, blocked service workers, animations killed, and an in-page
 * `Math.random` override seeded identically to the engine's RNG.
 *
 * Note: we deliberately do NOT freeze the page clock. Freezing time breaks many
 * real apps (polling, spinners, timeouts); the seed already reproduces the
 * monkey's own choices, which is what matters for replaying a bug.
 */
import { chromium, firefox, webkit } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

import { KEEP_IN_PAGE_INIT } from '../guardrails/fence';
import type { ResolvedConfig } from '../config/load';

const ENGINES = { chromium, firefox, webkit } as const;
export type Engine = keyof typeof ENGINES;

export async function launchBrowser(engine: Engine, headless: boolean): Promise<Browser> {
  return ENGINES[engine].launch({
    headless,
    timeout: 60_000,
    args: engine === 'chromium' ? ['--disable-dev-shm-usage'] : [],
  });
}

/** Seeds the page's Math.random with the same algorithm + seed as the engine
 *  RNG (xmur3 → splitmix32), so the two streams are identical. */
function seedPageRandom(seed: string): void {
  // This function body is serialized and run in the browser before page scripts.
  // Mirror xmur3(seed)() exactly: char loop, then the full three-step finalizer.
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  let a = h >>> 0;
  Math.random = () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

// Record client-side (SPA) navigations so the crawler can discover routes the
// app reaches via buttons/navigate() — not just <a href> links.
const RECORD_NAV_INIT = `
(() => {
  try {
    window.__bmNav = window.__bmNav || [];
    const push = () => { try { window.__bmNav.push(String(location.href)); } catch {} };
    for (const name of ['pushState', 'replaceState']) {
      const orig = history[name];
      if (typeof orig === 'function') {
        history[name] = function (...args) { const r = orig.apply(this, args); push(); return r; };
      }
    }
    window.addEventListener('popstate', push);
    window.addEventListener('hashchange', push);
  } catch {}
})();
`;

const KILL_ANIMATIONS_INIT = `
(() => {
  const css = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;}';
  const inject = () => { try { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); } catch {} };
  if (document.readyState !== 'loading') inject();
  else document.addEventListener('DOMContentLoaded', inject);
})();
`;

export interface SessionHandles {
  context: BrowserContext;
  page: Page;
}

export async function createDeterministicContext(
  browser: Browser,
  cfg: ResolvedConfig,
  videoDir?: string,
): Promise<SessionHandles> {
  const context = await browser.newContext({
    storageState: cfg.auth.storageState,
    viewport: cfg.viewport,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
    acceptDownloads: false, // never let a random click write a file to disk
    ...(cfg.report.captureVideo && videoDir
      ? { recordVideo: { dir: videoDir, size: cfg.viewport } }
      : {}),
  });

  // Order matters: random seeding + keep-in-page must run before page scripts.
  await context.addInitScript(seedPageRandom, cfg.seed);
  await context.addInitScript(KEEP_IN_PAGE_INIT);
  await context.addInitScript(KILL_ANIMATIONS_INIT);
  await context.addInitScript(RECORD_NAV_INIT);

  const page = await context.newPage();
  page.setDefaultTimeout(cfg.budget.actionTimeoutMs);
  page.setDefaultNavigationTimeout(Math.max(cfg.budget.actionTimeoutMs, 30_000));

  return { context, page };
}
