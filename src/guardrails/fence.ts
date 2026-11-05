/**
 * URL/navigation fence: bounds the monkey's blast radius. It blocks off-origin
 * document navigations, closes stray popups/tabs, hard-blocks dangerous paths,
 * dismisses (never accepts) native dialogs, and recovers if a JS-driven
 * navigation slips off-origin.
 */
import type { APIResponse, BrowserContext, Page, Request, Route } from 'playwright';

import type { SignalRecorder } from '../detectors/recorder';
import { inspectRequestForLiveMode, isPaymentHost } from './billing';

function safePostData(req: Request): string | null {
  try {
    return req.postData();
  } catch {
    return null;
  }
}

/**
 * URLs the fence has aborted. Every engine reports those cancellations, each in
 * its own words (Chromium `net::ERR_BLOCKED_BY_CLIENT`, Firefox
 * `NS_ERROR_FAILURE`, WebKit "Blocked by Web Inspector"), so the signal
 * listeners match on the URL instead of the text. Oldest entries are evicted
 * past `capacity` so a long run can't grow it without bound.
 */
export class FenceLog {
  private urls = new Set<string>();

  constructor(private readonly capacity = 2000) {}

  record(url: string): void {
    this.urls.delete(url);
    this.urls.add(url);
    if (this.urls.size > this.capacity) {
      const oldest = this.urls.values().next().value;
      if (oldest !== undefined) this.urls.delete(oldest);
    }
  }

  has(url: string): boolean {
    return this.urls.has(url);
  }
}

/** A compiled `guardrails.blockedRequests` entry. */
export interface RequestRule {
  /** Upper-case HTTP method; undefined matches any method. */
  method?: string;
  /** Path regex; null matches any path. */
  path: RegExp | null;
}

/** Compile `guardrails.blockedRequests`. The config schema has already
 *  validated each path, so a pattern that fails here throws rather than
 *  turning into a rule that matches every path. */
export function compileRequestRules(
  rules: readonly { method?: string; path?: string }[],
): RequestRule[] {
  return rules.map((rule) => ({
    method: rule.method?.toUpperCase(),
    path: rule.path === undefined ? null : new RegExp(rule.path, 'i'),
  }));
}

/** Index of the first rule that refuses `method` to `u`, or -1. The method is
 *  compared in upper case: fetch() upper-cases only the standard methods, so a
 *  page can send "patch", which servers commonly route as PATCH. */
export function matchRequestRule(rules: readonly RequestRule[], method: string, u: URL): number {
  const sent = method.toUpperCase();
  return rules.findIndex(
    (rule) =>
      (rule.method === undefined || rule.method === sent) &&
      (rule.path === null || isDangerousRoute(u, rule.path)),
  );
}

/** Path patterns that keep the crawl and link clicks away from a page: every
 *  blockedPathPatterns entry, plus the path of each blockedRequests rule that
 *  refuses a GET, since loading a page there would only be refused. */
export function navigationBlockedPatterns(guardrails: {
  blockedPathPatterns: readonly string[];
  blockedRequests: readonly { method?: string; path?: string }[];
}): string[] {
  const refusesGet = guardrails.blockedRequests.flatMap((rule) =>
    rule.path !== undefined && (rule.method === undefined || rule.method.toUpperCase() === 'GET')
      ? [rule.path]
      : [],
  );
  return [...guardrails.blockedPathPatterns, ...refusesGet];
}

export interface FenceOptions {
  allowedOrigins: readonly string[];
  /** Combined dangerous-path regex (or null). */
  blockedPathRe: RegExp | null;
  /** Compiled `guardrails.blockedRequests`. */
  blockedRequests?: readonly RequestRule[];
  /** Block media/font requests to cut noise. Images are kept so the
   *  broken-image detector stays meaningful. */
  blockMedia: boolean;
  /** Billing guard mode — controls network-level payment blocking. */
  billingMode: 'refuse' | 'warn' | 'off';
  /** True once live billing has been detected anywhere in the run. */
  isBillingLatched: () => boolean;
  /** Where aborted URLs are recorded, for listeners that must not report them. */
  aborted?: FenceLog;
  /**
   * Check where a document redirects before the browser follows it (first hop
   * only; never on WebKit, which cannot fulfill a 3xx). Off by default: every
   * document is then delivered with route.fulfill, which buffers it, drops its
   * Sec-Fetch-* headers, and makes Chromium treat it as public, so the page's
   * WebSockets to loopback or private hosts fail Local Network Access checks
   * unless the browser runs with those checks disabled.
   */
  vetRedirects?: boolean;
}

/** Static resource types that must never be path-blocked (they carry no
 *  destructive side effect and blocking them breaks app/module loading). */
const ASSET_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Why the fence refuses a request. */
type Refusal = 'request' | 'path' | 'origin' | 'live-payment' | 'latched-payment';

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

/** A route can sit in the query as well as the pathname (OpenCart logs out at
 *  index.php?route=account/logout). The pathname is also tested alone, so a
 *  pattern anchored on it (^/admin$) still matches when a query is attached.
 *  Hash-router routes never get here: no engine puts the fragment in a routed
 *  request's URL. */
function isDangerousRoute(u: URL, re: RegExp | null): boolean {
  if (!re) return false;
  return re.test(u.pathname) || re.test(u.pathname + u.search);
}

/** True when a committed URL is on an origin outside the allowed list. An
 *  opaque origin never counts: about:blank, data:, and the chrome-error://
 *  page Chromium commits after every aborted navigation (the fence's own
 *  blocks included) are not somewhere the app went. */
function escapedTo(url: string, allowed: ReadonlySet<string>): boolean {
  const o = safeOrigin(url);
  return o !== '' && o !== 'null' && !allowed.has(o);
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
    if (escapedTo(frame.url(), allowed)) {
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
    if (escapedTo(u, allowed)) {
      recorder.add('guardrail', `closed popup/new-tab → ${u}`, { severity: 'info' });
      void p.close().catch(() => {});
    }
  });

  const billingSeverity = opts.billingMode === 'refuse' ? 'critical' : 'medium';
  const requestRules = opts.blockedRequests ?? [];

  /** Checks 1-3, shared by a request and by a redirect it answers with. */
  const refusal = (
    u: URL,
    type: string,
    method: string,
    postData: () => string | null,
  ): Refusal | null => {
    // 1. Configured requests, then dangerous paths (logout/delete/cancel).
    //    Both block navigations, API calls and beacons, but NOT static
    //    asset/module loads. Otherwise a bundler serving modules from paths
    //    like /src/features/billing/* (resource type 'script') would be
    //    blocked and the SPA would never mount.
    if (!ASSET_TYPES.has(type)) {
      if (matchRequestRule(requestRules, method, u) !== -1) return 'request';
      if (isDangerousRoute(u, opts.blockedPathRe)) return 'path';
    }

    // 2. Off-origin document navigations.
    if (type === 'document' && !allowed.has(u.origin)) return 'origin';

    // 3. Payment safety: block real charges/tokenization at the network layer
    //    while still allowing test-mode/sandbox flows to be fuzzed.
    if (opts.billingMode !== 'off' && isPaymentHost(u.hostname)) {
      if (inspectRequestForLiveMode(u.href, postData()).length > 0) return 'live-payment';
      if (opts.isBillingLatched()) return 'latched-payment';
    }
    return null;
  };

  /** Which guard refused `method` to `u`, for the finding. */
  const guardName = (method: string, u: URL): string => {
    const rule = matchRequestRule(requestRules, method, u);
    return rule === -1 ? 'blocked path' : `guardrails.blockedRequests[${rule}]`;
  };

  /**
   * Record a refusal as an info `fence` finding, so a run shows what the fence
   * stopped, including a block it should not have made. Findings group by
   * route, and page loads from another origin by origin. Payment refusals,
   * and a payment provider's pages while billing detection is on, are the
   * billing guard's to report.
   */
  const report = (refused: Refusal, method: string, u: URL): void => {
    if (refused === 'origin') {
      if (opts.billingMode !== 'off' && isPaymentHost(u.hostname)) return;
      recorder.add('fence', `page load from ${u.origin}, outside the allowed origins`, {
        severity: 'info',
      });
    } else if (refused === 'request' || refused === 'path') {
      recorder.add('fence', `${method} ${u.href} (${guardName(method, u)})`, { severity: 'info' });
    }
  };

  /**
   * Playwright calls the route handler once per request and follows a 3xx
   * itself, so a page that redirected to /logout, or to another origin, went
   * out unchecked. A document is fetched here without following redirects,
   * and a redirect reaches the browser only if its target passes checks 1-3.
   * The browser follows it natively, so the hop after that one is not seen.
   */
  const fetchDocument = async (route: Route, from: URL): Promise<void> => {
    let response: APIResponse;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: 0 });
    } catch {
      // Unreachable from here (refused connection, page gone): let the
      // browser send it, as it did before this check existed.
      return route.continue().catch(() => {});
    }
    const status = response.status();
    const location = REDIRECT_STATUSES.has(status) ? response.headers()['location'] : undefined;
    const target = location ? parseUrl(location, from) : null;
    // 307 and 308 repeat the request's method; the other redirects load a page.
    const method = status === 307 || status === 308 ? route.request().method() : 'GET';
    const refused = target && refusal(target, 'document', method, () => null);
    if (target && refused) {
      // No request is ever made for this hop, so nothing else records it.
      if (refused === 'live-payment' || refused === 'latched-payment') {
        recorder.add('billing-live', `blocked a redirect to a payment page on ${target.hostname}`, {
          severity: billingSeverity,
        });
      } else {
        report(refused, method, target);
      }
      opts.aborted?.record(route.request().url());
      return route.abort('blockedbyclient').catch(() => {});
    }
    return route.fulfill({ response }).catch(() => {});
  };

  // WebKit refuses to fulfill a request with a 3xx, so it always follows
  // redirects unchecked.
  const vetsRedirects =
    opts.vetRedirects === true && context.browser()?.browserType().name() !== 'webkit';

  // WebSocket handshakes never reach context.route. A socket to a dangerous
  // path (ws://host/logout), or one a blockedRequests rule refuses as the GET
  // its handshake is, is routed here and closed without contacting the
  // server; every other socket connects natively, as fetch and XHR do.
  await context.routeWebSocket(
    (url) =>
      matchRequestRule(requestRules, 'GET', url) !== -1 ||
      isDangerousRoute(url, opts.blockedPathRe),
    (ws) => {
      opts.aborted?.record(ws.url());
      const u = new URL(ws.url());
      recorder.add('fence', `WebSocket ${u.href} (${guardName('GET', u)})`, { severity: 'info' });
      return ws.close({ code: 1008, reason: 'blocked by buttonmash' });
    },
  );

  // Route-level fence — the network layer is the real safety boundary.
  await context.route('**/*', (route) => {
    const req = route.request();
    const block = (): Promise<void> => {
      opts.aborted?.record(req.url());
      return route.abort('blockedbyclient');
    };
    const type = req.resourceType();
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return route.continue();
    }

    const method = req.method();
    const refused = refusal(u, type, method, () => safePostData(req));
    // Live evidence carried by the request itself is recorded, and the run
    // latched, by the signal listeners' `request` handler. Only a block that
    // rests on the latch alone is recorded here, so one event is one signal.
    if (refused === 'latched-payment') {
      recorder.add(
        'billing-live',
        `blocked a payment request to ${u.hostname} after live billing was detected`,
        { severity: billingSeverity },
      );
    }
    if (refused) {
      report(refused, method, u);
      return block();
    }

    // 4. Media/font noise (images kept so broken-image detection works).
    if (opts.blockMedia && (type === 'media' || type === 'font')) {
      return block();
    }
    if (type === 'document' && vetsRedirects) return fetchDocument(route, u);
    return route.continue();
  });
}

function parseUrl(url: string, base: URL): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
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
