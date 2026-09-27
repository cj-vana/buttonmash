/**
 * runPageChecks against real pages in Chromium: the structural probe runs in
 * the browser, so a mocked page.evaluate cannot say whether it works.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { loadConfig, type ResolvedConfig } from '../src/config/load';
import { runPageChecks, type DetectorState } from '../src/detectors/page-checks';
import { SignalRecorder } from '../src/detectors/recorder';

/** 1x1 transparent GIF. */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

let browser: Browser;
let context: BrowserContext;
let page: Page;
let cfg: ResolvedConfig;
let recorder: SignalRecorder;
let state: DetectorState;

beforeAll(async () => {
  browser = await chromium.launch();
  cfg = await loadConfig({ ignoreConfigFile: true, overrides: { target: 'http://127.0.0.1' } });
  context = await browser.newContext({ viewport: cfg.viewport });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** Served at an http origin: the checks skip about:blank, where setContent writes. */
const APP_URL = 'http://app.test/';
let served = '';

beforeEach(async () => {
  await page?.close();
  page = await context.newPage();
  await page.route(APP_URL, (route) =>
    route.fulfill({ body: served, contentType: 'text/html; charset=utf-8' }),
  );
  recorder = new SignalRecorder();
  state = { pendingCanaries: new Set(), seenBrokenImages: new Set() };
});

async function check(html: string, newState = false): Promise<string[]> {
  served = html;
  await page.goto(APP_URL);
  await runChecks(newState);
  return recorder.signals.map((s) => `${s.kind}/${s.severity}: ${s.detail}`);
}

async function runChecks(newState: boolean): Promise<void> {
  await runPageChecks(
    {
      page,
      recorder,
      cfg,
      state,
      markBillingLive: () => {},
      customDom: [],
      customUrl: [],
      timeLeftMs: 10_000,
    },
    newState,
  );
}

const isBlank = (signals: string[]) => signals.some((s) => s.startsWith('blank-screen/'));

describe('reflected input', () => {
  const CANARY = 'cnry1a2b3c4dzz';
  /** fuzz.ts's reflection probe: quote and angle characters, then the canary. */
  const PROBE = `"'<>${CANARY}`;
  const reflections = async (html: string) => {
    state.pendingCanaries.add(CANARY);
    return (await check(html, true)).filter((s) => s.startsWith('reflected-input/'));
  };

  it('reports an innerHTML echo that follows an escaped attribute echo', async () => {
    const html =
      `<!doctype html><form><input name="q" value="${CANARY}"></form><h1 id="h"></h1>` +
      `<script>document.getElementById('h').innerHTML = 'Results for ' + ${JSON.stringify(PROBE)};</script>`;
    const found = await reflections(html);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^reflected-input\/low: input reflected into page text: /);
    expect(found[0]).toContain(`Results for "'&lt;&gt;${CANARY}`);
  });

  it('does not call a safe textContent echo an XSS sink', async () => {
    const html =
      '<!doctype html><h1 id="h"></h1><script>' +
      `document.getElementById('h').textContent = 'Results for ' + ${JSON.stringify(PROBE)};</script>`;
    const found = await reflections(html);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^reflected-input\/low: /);
    expect(found[0]).not.toMatch(/xss|sink|unencoded/i);
  });

  it('reports a plain echo in page text as low', async () => {
    const found = await reflections(`<!doctype html><div>${CANARY}</div>`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^reflected-input\/low: /);
  });
});

describe('framework error overlay', () => {
  /** What Next.js 15/16 dev servers append to every page: a <nextjs-portal>
   *  whose dev overlay lives inside an open shadow root. */
  const nextPage = (shadowHtml: string) =>
    '<!doctype html><main><h1>Dashboard</h1></main><nextjs-portal></nextjs-portal><script>' +
    "document.querySelector('nextjs-portal').attachShadow({ mode: 'open' }).innerHTML = " +
    `${JSON.stringify(shadowHtml)};</script>`;
  const overlays = (signals: string[]) => signals.filter((s) => s.startsWith('error-overlay/'));

  it('does not report the empty portal every Next.js dev page carries', async () => {
    expect(overlays(await check(nextPage('<div data-nextjs-toast></div>')))).toEqual([]);
  });

  it('reports the error dialog inside the portal shadow root', async () => {
    const dialog =
      '<div data-nextjs-dialog role="dialog"><span id="nextjs__container_errors_label">' +
      'Runtime Error</span></div>';
    expect(overlays(await check(nextPage(dialog)))).toEqual([
      'error-overlay/high: framework error overlay detected ([data-nextjs-dialog])',
    ]);
  });

  it('reports the error label inside the portal shadow root', async () => {
    const label = '<span id="nextjs__container_errors_label">Build Error</span>';
    expect(overlays(await check(nextPage(label)))).toEqual([
      'error-overlay/high: framework error overlay detected (#nextjs__container_errors_label)',
    ]);
  });
});

describe('blank screen', () => {
  it('flags an SPA whose root never rendered', async () => {
    const html =
      '<!doctype html><html><head><title>app</title></head><body><div id="root"></div></body></html>';
    expect(isBlank(await check(html))).toBe(true);
  });

  it('flags a page whose only elements are a hidden sprite, a hidden input and a pixel', async () => {
    const html =
      '<!doctype html><svg style="display:none"><symbol id="i"><path d="M0 0h1v1z"/></symbol></svg>' +
      `<input type="hidden" name="csrf" value="x"><img src="${PIXEL}" width="1" height="1" alt="">` +
      '<div id="root"></div>';
    expect(isBlank(await check(html))).toBe(true);
  });

  it('flags a page whose only text is a skip link parked off screen', async () => {
    const html =
      '<!doctype html><a href="#main" style="position:absolute;left:-9999px">Skip to content</a>' +
      '<main id="main"></main>';
    expect(isBlank(await check(html))).toBe(true);
  });

  it('does not flag about:blank, where a step back past the first page lands', async () => {
    await runChecks(false);
    expect(page.url()).toBe('about:blank');
    expect(isBlank(recorder.signals.map((s) => `${s.kind}/`))).toBe(false);
  });

  it('does not flag visible text', async () => {
    expect(isBlank(await check('<!doctype html><div id="root"><p>Welcome back</p></div>'))).toBe(
      false,
    );
  });

  it('does not flag a visible canvas', async () => {
    const html = '<!doctype html><canvas width="640" height="480"></canvas>';
    expect(isBlank(await check(html))).toBe(false);
  });

  it('does not flag a visible image', async () => {
    const html = `<!doctype html><img src="${PIXEL}" width="320" height="200" alt="">`;
    expect(isBlank(await check(html))).toBe(false);
  });

  it('does not flag text rendered inside an open shadow root', async () => {
    const html =
      '<!doctype html><app-shell></app-shell><script>' +
      "document.querySelector('app-shell').attachShadow({ mode: 'open' }).innerHTML =" +
      " '<p>Rendered by a web component</p>';</script>";
    expect(isBlank(await check(html))).toBe(false);
  });
});
