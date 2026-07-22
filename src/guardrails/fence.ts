/**
 * URL/navigation fence: bounds the monkey's blast radius. It blocks off-origin
 * document navigations, closes stray popups/tabs, hard-blocks dangerous paths,
 * dismisses (never accepts) native dialogs, and recovers if a JS-driven
 * navigation slips off-origin.
 */
import type { BrowserContext, Page, Request } from 'playwright';

import type { SignalRecorder } from '../detectors/recorder';
import { LIVE_HOSTS, inspectRequestForLiveMode, isPaymentHost } from './billing';

function safePostData(req: Request): string | null {
  try {
    return req.postData();
  } catch {
    return null;
  }
}

export interface FenceOptions {
  allowedOrigins: readonly string[];
  /** Combined dangerous-path regex (or null). */
  blockedPathRe: RegExp | null;
  /** Block media/font requests to cut noise. Images are kept so the
   *  broken-image detector stays meaningful. */
  blockMedia: boolean;
  /** Billing guard mode — controls network-level payment blocking. */
  billingMode: 'refuse' | 'warn' | 'off';
  /** True once live billing has been detected anywhere in the run. */
  isBillingLatched: () => boolean;
}

/** Static resource types that must never be path-blocked (they carry no
 *  destructive side effect and blocking them breaks app/module loading). */
const ASSET_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function isAllowedOrigin(url: string, allowed: ReadonlySet<string>): boolean {
  const o = safeOrigin(url);
  return o === '' || allowed.has(o);
}

/** Page-level fence handlers. Re-attached whenever a page is (re)created. */
export function attachPageFence(page: Page, opts: FenceOptions, recorder: SignalRecorder): void {
  const allowed = new Set(opts.allowedOrigins);

  // Never auto-confirm destructive native dialogs — always dismiss.
  page.on('dialog', async (dialog) => {
    recorder.add('dialog', `${dialog.type()}: ${dialog.message()}`, { severity: 'low' });
    try {
      await dialog.dismiss();
    } catch {
      /* already handled */
    }
  });

  // Decline file-chooser dialogs so a click on <input type=file> can't hang.
  page.on('filechooser', (fc) => void fc.setFiles([]).catch(() => {}));

  page.on('popup', (p) => void p.close().catch(() => {}));

  // Catch JS-driven navigations that slipped through routing.
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    const o = safeOrigin(frame.url());
    if (o !== '' && !allowed.has(o)) {
      recorder.add('guardrail', `recovered off-origin navigation → ${frame.url()}`, {
        severity: 'low',
      });
      await page.goBack().catch(() => {});
    }
  });
}

/** Context-level fence — installed once; applies to every page in the context. */
export async function installContextFence(
  context: BrowserContext,
  opts: FenceOptions,
  recorder: SignalRecorder,
): Promise<void> {
  const allowed = new Set(opts.allowedOrigins);

  // Close any popup / new tab that escapes to a foreign origin.
  context.on('page', (p) => {
    const u = p.url();
    if (u && u !== 'about:blank' && !allowed.has(safeOrigin(u))) {
      recorder.add('guardrail', `closed popup/new-tab → ${u}`, { severity: 'info' });
      void p.close().catch(() => {});
    }
  });

  // Route-level fence — the network layer is the real safety boundary.
  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    let origin = '';
    let host = '';
    let pathname = '';
    try {
      const u = new URL(req.url());
      origin = u.origin;
      host = u.host;
      pathname = u.pathname;
    } catch {
      return route.continue();
    }

    // 1. Dangerous paths (logout/delete/cancel) — block navigations, API calls,
    //    and beacons, but NOT static asset/module loads. Otherwise a bundler
    //    serving modules from paths like /src/features/billing/* (resource type
    //    'script') would be blocked and the SPA would never mount.
    if (!ASSET_TYPES.has(type) && opts.blockedPathRe?.test(pathname)) {
      return route.abort('blockedbyclient');
    }

    // 2. Off-origin document navigations.
    const offOrigin = origin !== '' && !allowed.has(origin);
    if (type === 'document' && offOrigin) return route.abort('blockedbyclient');

    // 3. Payment safety: block real charges/tokenization at the network layer
    //    while still allowing test-mode/sandbox flows to be fuzzed.
    if (opts.billingMode !== 'off' && isPaymentHost(host)) {
      const post = safePostData(req);
      const liveByKey = inspectRequestForLiveMode(req.url(), post).length > 0;
      const liveHost = LIVE_HOSTS.has(host);
      if (liveHost || liveByKey || opts.isBillingLatched()) {
        recorder.add('billing-live', `blocked live payment request → ${host}`, {
          severity: opts.billingMode === 'refuse' ? 'critical' : 'medium',
        });
        return route.abort('blockedbyclient');
      }
    }

    // 4. Media/font noise (images kept so broken-image detection works).
    if (opts.blockMedia && (type === 'media' || type === 'font')) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}

/** Init script (added before navigation) that keeps clicks in-page. */
export const KEEP_IN_PAGE_INIT = `
(() => {
  const strip = () => {
    for (const a of document.querySelectorAll('a[target]')) a.removeAttribute('target');
    for (const f of document.querySelectorAll('form[target]')) f.removeAttribute('target');
    for (const b of document.querySelectorAll('[formtarget]')) b.removeAttribute('formtarget');
  };
  if (document.readyState !== 'loading') strip();
  document.addEventListener('DOMContentLoaded', strip);
  try {
    new MutationObserver(strip).observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
  try { window.open = () => null; } catch {}
})();
`;
