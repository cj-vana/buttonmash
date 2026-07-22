/**
 * Per-state DOM oracles that can't be observed from events: blank "white screen
 * of death", broken images, client-exposed secrets, live billing keys in the
 * DOM, reflected-input (safe XSS canary), and optional axe-core a11y scans.
 */
import type { Page } from 'playwright';

import type { ResolvedConfig } from '../config/load';
import { withDeadline } from '../core/async';
import type { Severity } from '../core/types';
import { scanTextForLiveMode } from '../guardrails/billing';
import { redactString, scanForSecrets } from '../guardrails/secrets';
import type { SignalRecorder } from './recorder';

/** Mutable per-run state shared with the detectors. */
export interface DetectorState {
  /** Canaries typed into inputs, awaiting a reflection check. */
  pendingCanaries: Set<string>;
  /** Broken image srcs already reported (avoid re-reporting each step). */
  seenBrokenImages: Set<string>;
}

/** Track a typed canary, evicting the oldest beyond a bound — a long run must
 *  not rescan an ever-growing set against the full HTML on every new state. */
export function addCanary(state: DetectorState, canary: string): void {
  if (state.pendingCanaries.size >= 200) {
    const oldest = state.pendingCanaries.values().next().value;
    if (oldest !== undefined) state.pendingCanaries.delete(oldest);
  }
  state.pendingCanaries.add(canary);
}

export interface CustomTextRule {
  name: string;
  re: RegExp;
  severity: Severity;
}

export interface PageCheckDeps {
  page: Page;
  recorder: SignalRecorder;
  cfg: ResolvedConfig;
  state: DetectorState;
  markBillingLive: (reasons: string[]) => void;
  /** Custom rules whose pattern is matched against page text (on new states). */
  customDom: CustomTextRule[];
  /** Custom rules whose pattern is matched against the current URL (each step). */
  customUrl: CustomTextRule[];
  /** Remaining wall-clock budget (ms); the slow a11y scan is skipped when low. */
  timeLeftMs: number;
}

/** Runs in the browser. Cheap structural snapshot for blank/broken-image/overlay. */
function domCheck(): { blank: boolean; brokenImages: string[]; overlay: string | null } {
  const body = document.body;
  const text = (body?.innerText || '').trim();
  const interactive = document.querySelectorAll(
    'a[href],button,input,select,textarea,[role="button"],[onclick]',
  ).length;
  const imgs = Array.from(document.images);
  const broken: string[] = [];
  for (const img of imgs) {
    const src = img.currentSrc || img.src;
    if (img.complete && img.naturalWidth === 0 && src) broken.push(src);
  }
  const scrollH = document.documentElement?.scrollHeight ?? 0;
  // A rendered canvas/svg/video is content — a pure-canvas game has no text,
  // no <img>, no interactive DOM nodes, and must not read as a white screen.
  const media = document.querySelectorAll('canvas,svg,video').length;
  const blank =
    !!body &&
    text.length < 3 &&
    imgs.length === 0 &&
    interactive === 0 &&
    media === 0 &&
    scrollH < 60;

  // Framework error overlays — error boundaries often don't re-throw to window,
  // so neither pageerror nor blank-screen fires. Match TIGHT signatures only.
  const OVERLAY_SELECTORS = [
    'nextjs-portal',
    'vite-error-overlay',
    '#vite-error-overlay',
    '[data-nextjs-dialog]',
    '#nextjs__container_errors_label',
    '#webpack-dev-server-client-overlay',
    'react-error-overlay',
  ];
  let overlay: string | null = null;
  for (const s of OVERLAY_SELECTORS) {
    if (document.querySelector(s)) {
      overlay = s;
      break;
    }
  }
  if (
    !overlay &&
    /Application error: a client-side exception|Unexpected Application Error/i.test(text)
  ) {
    overlay = 'framework error message';
  }
  return { blank, brokenImages: Array.from(new Set(broken)).slice(0, 20), overlay };
}

/**
 * True if position `idx` in `lowerHtml` is a context where a reflected value is
 * NOT an XSS sink: inside an open tag (attribute value) or inside a raw-text /
 * RCDATA element (textarea/title/script/style). Used to suppress the common
 * false positive of a framework echoing typed input back into a control.
 */
export function isSafeReflectionContext(lowerHtml: string, idx: number): boolean {
  // Inside a tag's attributes: the nearest '<' before idx isn't yet closed.
  if (lowerHtml.lastIndexOf('<', idx) > lowerHtml.lastIndexOf('>', idx)) return true;
  for (const tag of ['textarea', 'title', 'script', 'style']) {
    const open = lowerHtml.lastIndexOf(`<${tag}`, idx);
    const close = lowerHtml.lastIndexOf(`</${tag}`, idx);
    if (open !== -1 && open > close) return true;
  }
  return false;
}

async function runAxe(deps: PageCheckDeps): Promise<void> {
  const { page, recorder } = deps;
  try {
    const mod = (await import('axe-core')) as unknown as {
      source?: string;
      default?: { source?: string };
    };
    const source = mod.source ?? mod.default?.source;
    if (!source) return;
    await withDeadline(page.evaluate(source), 8_000, 'axe/inject');
    const results = (await withDeadline(
      page.evaluate(async () => {
        // Save/restore the (seeded) Math.random around axe so its internal RNG
        // use doesn't perturb the app-under-test's deterministic stream.
        const saved = Math.random;
        try {
          return await (window as any).axe.run(document, { resultTypes: ['violations'] });
        } finally {
          Math.random = saved;
        }
      }),
      30_000,
      'axe/run',
    )) as { violations?: Array<{ id: string; help: string; impact?: string; nodes?: unknown[] }> };
    for (const v of results.violations ?? []) {
      if (v.impact === 'critical' || v.impact === 'serious') {
        const severity: Severity = v.impact === 'critical' ? 'high' : 'medium';
        recorder.add('a11y', `${v.id}: ${v.help} (${v.nodes?.length ?? 0} nodes)`, { severity });
      }
    }
  } catch {
    /* a11y is best-effort */
  }
}

export async function runPageChecks(deps: PageCheckDeps, newState: boolean): Promise<void> {
  const { page, recorder, cfg, state } = deps;

  // 1. Cheap structural checks (every step).
  let dom: { blank: boolean; brokenImages: string[]; overlay: string | null };
  try {
    dom = await withDeadline(page.evaluate(domCheck), 8_000, 'page-checks/dom');
  } catch {
    return; // frozen/navigating page; the hang watchdog covers this
  }
  if (cfg.detectors.blankScreen && dom.blank) {
    recorder.add('blank-screen', 'page rendered blank/empty (possible white screen of death)', {
      severity: 'high',
    });
  }
  if (cfg.detectors.brokenImages) {
    for (const src of dom.brokenImages) {
      if (!state.seenBrokenImages.has(src)) {
        state.seenBrokenImages.add(src);
        recorder.add('broken-image', src, { severity: 'low' });
      }
    }
  }
  if (cfg.detectors.errorOverlay && dom.overlay) {
    recorder.add('error-overlay', `framework error overlay detected (${dom.overlay})`, {
      severity: 'high',
    });
  }

  // Custom url rules (cheap, every step).
  if (deps.customUrl.length) {
    const u = page.url();
    for (const rule of deps.customUrl) {
      if (rule.re.test(u))
        recorder.add('custom', `${rule.name}: ${u}`, { severity: rule.severity });
    }
  }

  if (!newState) return;

  // 2. Content scans (only on newly-discovered states).
  let html = '';
  let scripts = '';
  let globals = '';
  try {
    html = await withDeadline(page.content(), 8_000, 'page-checks/content');
    scripts = await withDeadline(
      page.$$eval('script', (els) => els.map((e) => e.textContent || '').join('\n')),
      6_000,
      'page-checks/scripts',
    );
    globals = await withDeadline(
      page.evaluate(() => {
        try {
          return JSON.stringify(window).slice(0, 200_000);
        } catch {
          return '';
        }
      }),
      6_000,
      'page-checks/globals',
    ).catch(() => '');
  } catch {
    /* partial content is still useful */
  }

  if (cfg.guardrails.billing.mode !== 'off') {
    const reasons = scanTextForLiveMode(`${html}\n${scripts}\n${globals}`);
    if (reasons.length) {
      const severity: Severity = cfg.guardrails.billing.mode === 'refuse' ? 'critical' : 'medium';
      recorder.add('billing-live', reasons.join(', '), { severity });
      deps.markBillingLive(reasons);
    }
  }

  if (cfg.guardrails.secrets.report) {
    for (const hit of scanForSecrets(`${html}\n${scripts}`)) {
      recorder.add('secret-leak', `${hit.ruleId} (page): ${hit.context}`, { severity: 'high' });
    }
  }

  // Custom dom rules — matched against the page markup on new states.
  if (deps.customDom.length && html) {
    for (const rule of deps.customDom) {
      if (rule.re.test(html)) recorder.add('custom', rule.name, { severity: rule.severity });
    }
  }

  if (cfg.detectors.reflectedInput && state.pendingCanaries.size && html) {
    const lowerHtml = html.toLowerCase();
    for (const canary of [...state.pendingCanaries]) {
      const idx = html.indexOf(canary);
      if (idx === -1) continue;
      // Skip reflections in contexts that are NOT XSS sinks: inside an
      // attribute/tag (e.g. a controlled <input value="…">) or inside a
      // raw-text/RCDATA element (textarea/title/script/style). These are the
      // dominant false-positive source — React echoing typed input.
      if (isSafeReflectionContext(lowerHtml, idx)) {
        state.pendingCanaries.delete(canary);
        continue;
      }
      const before = html.slice(Math.max(0, idx - 25), idx);
      const unencoded = /[<>"'][^<>]{0,20}$/.test(before);
      const rawCtx = html.slice(Math.max(0, idx - 40), idx + canary.length + 40);
      // Redact before persisting — a secret could be reflected next to the canary.
      const ctx = cfg.guardrails.secrets.redact ? redactString(rawCtx) : rawCtx;
      recorder.add(
        'reflected-input',
        `input reflected into page${
          unencoded ? ' adjacent to unencoded HTML chars (possible XSS sink)' : ''
        }: …${ctx}…`,
        { severity: unencoded ? 'medium' : 'low' },
      );
      state.pendingCanaries.delete(canary);
    }
  }

  // 3. Accessibility (opt-in, slower) — skipped when little budget remains so a
  //    long axe scan can't overshoot --max-duration and trip the CI timeout.
  if (cfg.detectors.a11y && deps.timeLeftMs > 40_000) await runAxe(deps);
}
