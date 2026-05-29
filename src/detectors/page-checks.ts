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

export interface PageCheckDeps {
  page: Page;
  recorder: SignalRecorder;
  cfg: ResolvedConfig;
  state: DetectorState;
  markBillingLive: (reasons: string[]) => void;
}

/** Runs in the browser. Cheap structural snapshot for blank/broken-image checks. */
function domCheck(): { blank: boolean; brokenImages: string[] } {
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
  const blank = !!body && text.length < 3 && imgs.length === 0 && interactive === 0 && scrollH < 60;
  return { blank, brokenImages: Array.from(new Set(broken)).slice(0, 20) };
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
  let dom: { blank: boolean; brokenImages: string[] };
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

  if (cfg.detectors.reflectedInput && state.pendingCanaries.size && html) {
    for (const canary of [...state.pendingCanaries]) {
      const idx = html.indexOf(canary);
      if (idx === -1) continue;
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

  // 3. Accessibility (opt-in, slower).
  if (cfg.detectors.a11y) await runAxe(deps);
}
