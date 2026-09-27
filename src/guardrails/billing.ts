/**
 * Payment / billing safety. Goal: never let the monkey transact with real
 * money. We detect *live mode* from three independent sources (page text,
 * outbound requests, processor hosts) and OR them together.
 *
 * Key insight from research: publishable keys (pk_live_) are SUPPOSED to be in
 * client JS — finding one simply means "this is a live store", which is exactly
 * the trigger to refuse payment interaction. Do not confuse this with a secret
 * leak (sk_/rk_/whsec_), which is handled by guardrails/secrets.ts.
 *
 * Refs: https://docs.stripe.com/keys
 */

export interface BillingPattern {
  id: string;
  re: RegExp;
}

/** Presence of any of these ⇒ live payment mode ⇒ refuse to touch payment UI. */
// No upper bound on key length: with `{10,99}` a key whose alphanumeric tail
// exceeded 99 chars matched NOTHING (the trailing \b can only sit at the key's
// true end), silently bypassing live-mode refusal. Stripe documents that key
// length may change.
export const LIVE_MODE_PATTERNS: BillingPattern[] = [
  { id: 'stripe-pk-live', re: /\bpk_live_[a-zA-Z0-9]{10,}\b/ },
  { id: 'stripe-sk-live', re: /\bsk_live_[a-zA-Z0-9]{10,}\b/ },
  { id: 'stripe-rk-live', re: /\brk_live_[a-zA-Z0-9]{10,}\b/ },
  { id: 'braintree-production', re: /\bproduction_[a-z0-9]{8,}_[a-z0-9]{8,}\b/ },
];

/** Presence of these is reassuring (test mode) but not conclusive on its own. */
export const TEST_MODE_PATTERNS: BillingPattern[] = [
  { id: 'stripe-pk-test', re: /\bpk_test_[a-zA-Z0-9]{10,}\b/ },
  { id: 'braintree-sandbox', re: /\bsandbox_[a-z0-9]{8,}_[a-z0-9]{8,}\b/ },
];

/** Outbound requests to these hosts mean live processing. www.paypal.com is
 *  decided per request instead (see paypalIsLive): sandbox integrations load
 *  the SDK from it too. */
export const LIVE_HOSTS = new Set([
  'api.braintreegateway.com',
  'connect.squareup.com',
  'checkout.adyen.com',
  'live.adyen.com',
]);

/** Registrable domains of payment processors. Matching processor words
 *  anywhere in the host also caught the app's own `checkout.acme.test`. */
const PAYMENT_DOMAINS = [
  'stripe.com',
  'stripe.network',
  'paypal.com',
  'paypalobjects.com',
  'braintreegateway.com',
  'braintree-api.com',
  'adyen.com',
  'squareup.com',
  'squareupsandbox.com',
  'squarecdn.com',
  'checkout.com',
];

function onDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** paypal-js loads the SDK from here unless told `environment: "sandbox"`;
 *  the client id then decides which environment it talks to. */
const PAYPAL_LIVE_HOST = 'www.paypal.com';

/** Placeholder client ids that run the SDK against the sandbox: `sb`, and
 *  `test` (what paypal-js's own e2e fixture loads,
 *  packages/paypal-js/e2e-tests/browser-global.html). Any other id may be live. */
const PAYPAL_SANDBOX_CLIENT_IDS = new Set(['sb', 'test']);

/** Paths on www.paypal.com that create, approve or capture a payment. */
const PAYPAL_PAYMENT_PATH_RE =
  /^\/(?:checkout|v1\/|v2\/|smart\/api\/|cgi-bin\/webscr|webapps\/hermes|donate)/;

function paypalIsLive(u: URL): boolean {
  if (u.pathname.startsWith('/sdk/js')) {
    return !PAYPAL_SANDBOX_CLIENT_IDS.has(u.searchParams.get('client-id') ?? '');
  }
  // The v6 SDK takes its environment from the host it is loaded from.
  if (u.pathname.startsWith('/web-sdk/')) return true;
  return PAYPAL_PAYMENT_PATH_RE.test(u.pathname);
}

/** Detect live-mode evidence in a blob of page text (HTML + scripts + globals). */
export function scanTextForLiveMode(text: string): string[] {
  const reasons: string[] = [];
  for (const { id, re } of LIVE_MODE_PATTERNS) {
    if (re.test(text)) reasons.push(`live-key-in-page:${id}`);
  }
  return reasons;
}

/** Detect live-mode evidence in a single outbound request. */
export function inspectRequestForLiveMode(url: string, postData: string | null): string[] {
  const reasons: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return reasons;
  }
  const host = parsed.hostname;
  if (LIVE_HOSTS.has(host) || (host === PAYPAL_LIVE_HOST && paypalIsLive(parsed))) {
    reasons.push(`live-host:${host}`);
  }
  const haystack = `${url}\n${postData ?? ''}`;
  // api.stripe.com serves test and live mode alike; the key decides.
  if (onDomain(host, 'stripe.com')) {
    for (const { id, re } of LIVE_MODE_PATTERNS) {
      if (re.test(haystack)) reasons.push(`live-key-in-request:${id}`);
    }
  }
  return reasons;
}

/** True if a hostname (no port) belongs to a payment processor. */
export function isPaymentHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return PAYMENT_DOMAINS.some((domain) => onDomain(h, domain));
}
