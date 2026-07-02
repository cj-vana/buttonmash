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

/** Outbound requests to these hosts mean live processing. */
export const LIVE_HOSTS = new Set([
  'www.paypal.com',
  'api.braintreegateway.com',
  'connect.squareup.com',
  'checkout.adyen.com',
  'live.adyen.com',
]);

export const SANDBOX_HOSTS = new Set([
  'www.sandbox.paypal.com',
  'api.sandbox.braintreegateway.com',
  'connect.squareupsandbox.com',
  'checkout-test.adyen.com',
]);

/** api.stripe.com is shared by test & live; decide by the key in the request. */
const STRIPE_HOSTS = new Set(['api.stripe.com', 'r.stripe.com']);

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
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return reasons;
  }
  if (LIVE_HOSTS.has(host)) reasons.push(`live-host:${host}`);
  const haystack = `${url}\n${postData ?? ''}`;
  if (STRIPE_HOSTS.has(host) || host.endsWith('stripe.com')) {
    for (const { id, re } of LIVE_MODE_PATTERNS) {
      if (re.test(haystack)) reasons.push(`live-key-in-request:${id}`);
    }
  }
  return reasons;
}

/** True if a host looks payment-related at all (for tagging payment subtrees). */
export function isPaymentHost(host: string): boolean {
  return (
    STRIPE_HOSTS.has(host) ||
    LIVE_HOSTS.has(host) ||
    SANDBOX_HOSTS.has(host) ||
    /(?:paypal|braintree|adyen|squareup|stripe|checkout)\./.test(host)
  );
}
