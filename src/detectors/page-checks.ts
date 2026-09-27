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

/** Runs in the browser, so it must not reference anything outside itself.
 *  Cheap structural snapshot for blank/broken-image/overlay. */
function domCheck(): { blank: boolean; brokenImages: string[]; overlay: string | null } {
  const body = document.body;
  const text = (body?.innerText || '').trim();
  const broken: string[] = [];
  for (const img of Array.from(document.images)) {
    const src = img.currentSrc || img.src;
    if (img.complete && img.naturalWidth === 0 && src) broken.push(src);
  }

  // Blank means nothing visible was rendered. Counting elements never worked:
  // scrollHeight is never below the viewport, and a hidden svg sprite, a
  // hidden input or a tracking pixel is an element too. So look for visible
  // text, media or controls with a real box, including inside open shadow
  // roots (web-component apps render everything there).
  const MEDIA = new Set([
    'img',
    'svg',
    'canvas',
    'video',
    'iframe',
    'object',
    'embed',
    'input',
    'button',
    'select',
    'textarea',
  ]);
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    // Under 2px is a pixel or an sr-only clip; entirely left of or above the
    // page is a parked skip link.
    if (r.width < 2 || r.height < 2 || r.right + scrollX <= 0 || r.bottom + scrollY <= 0) {
      return false;
    }
    return (
      typeof el.checkVisibility !== 'function' ||
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    );
  };
  let budget = 20_000;
  let textSeen = 0;
  const rendersSomething = (root: ParentNode): boolean => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      // A DOM this big is not a white screen.
      if (--budget < 0) return true;
      if (MEDIA.has(el.localName) && visible(el)) return true;
      for (const node of Array.from(el.childNodes)) {
        const chars = node.nodeType === 3 ? (node.textContent ?? '').trim().length : 0;
        if (chars && visible(el)) {
          textSeen += chars;
          if (textSeen >= 3) return true;
        }
      }
      if (el.shadowRoot && rendersSomething(el.shadowRoot)) return true;
      if (getComputedStyle(el).backgroundImage !== 'none' && visible(el)) return true;
    }
    return false;
  };
  // about:blank (a history step back past the first page), chrome-error:// (a
  // navigation the fence aborted) and data: are not the app.
  const appPage = location.protocol === 'http:' || location.protocol === 'https:';
  const blank = !!body && appPage && document.readyState !== 'loading' && !rendersSomething(body);

  // Framework error overlays — error boundaries often don't re-throw to window,
  // so neither pageerror nor blank-screen fires. Match TIGHT signatures only.
  const OVERLAY_SELECTORS = [
    'vite-error-overlay',
    '#vite-error-overlay',
    '[data-nextjs-dialog]',
    '#nextjs__container_errors_label',
    '#webpack-dev-server-client-overlay',
    'react-error-overlay',
  ];
  // Next.js 15/16 append a <nextjs-portal> to every dev page, error or not, and
  // renders its overlay inside the portal's open shadow root, out of reach of
  // document.querySelector.
  const overlayRoots: ParentNode[] = [document];
  for (const portal of Array.from(document.querySelectorAll('nextjs-portal'))) {
    if (portal.shadowRoot) overlayRoots.push(portal.shadowRoot);
  }
  let overlay: string | null = null;
  for (const s of OVERLAY_SELECTORS) {
    if (overlayRoots.some((root) => root.querySelector(s))) {
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

/**
 * Index of the first place `canary` is echoed into page text, or -1. Every
 * occurrence is checked: a controlled `<input value>` echo usually comes first
 * and must not hide a later reflection into the page body.
 */
export function findTextReflection(html: string, lowerHtml: string, canary: string): number {
  for (let idx = html.indexOf(canary); idx !== -1; idx = html.indexOf(canary, idx + 1)) {
    if (!isSafeReflectionContext(lowerHtml, idx)) return idx;
  }
  return -1;
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
        // JSON.stringify(window) throws on the window.window cycle on every
        // page, so each of the page's own globals is serialized on its own.
        // Accessors are browser APIs (document, location, ...) and are skipped
        // without running their getters; the node budget bounds the work a
        // huge state tree can cost the page.
        const cap = 200_000;
        let nodes = 50_000;
        const budgeted = (_key: string, value: unknown) => (nodes-- > 0 ? value : undefined);
        let out = '';
        for (const key of Object.keys(window)) {
          const desc = Object.getOwnPropertyDescriptor(window, key);
          if (!desc || !('value' in desc) || typeof desc.value === 'function') continue;
          try {
            const json = JSON.stringify(desc.value, budgeted);
            if (json) out += `${key}=${json}\n`;
          } catch {
            // a cycle or a throwing toJSON: skip this global, keep the rest
          }
          if (out.length >= cap || nodes <= 0) break;
        }
        return out.slice(0, cap);
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
    // Redact the whole page before cutting context around a reflection, so a
    // secret next to it cannot survive cut in half at the window edge.
    const shown = cfg.guardrails.secrets.redact ? redactString(html) : html;
    const lower = shown.toLowerCase();
    for (const canary of [...state.pendingCanaries]) {
      if (!shown.includes(canary)) continue;
      state.pendingCanaries.delete(canary);
      // Echoes inside an attribute or a textarea/title/script/style are not
      // page text (React echoing typed input into its control).
      const idx = findTextReflection(shown, lower, canary);
      if (idx === -1) continue;
      // page.content() re-serializes the DOM, which escapes text either way,
      // so it cannot tell an escaped echo from markup injected by an HTML sink.
      const ctx = shown.slice(Math.max(0, idx - 40), idx + canary.length + 40);
      recorder.add('reflected-input', `input reflected into page text: …${ctx}…`, {
        severity: 'low',
      });
    }
  }

  // 3. Accessibility (opt-in, slower) — skipped when little budget remains so a
  //    long axe scan can't overshoot --max-duration and trip the CI timeout.
  if (cfg.detectors.a11y && deps.timeLeftMs > 40_000) await runAxe(deps);
}
