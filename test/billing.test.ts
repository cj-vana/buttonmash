import { describe, it, expect } from 'vitest';
import {
  scanTextForLiveMode,
  inspectRequestForLiveMode,
  isPaymentHost,
} from '../src/guardrails/billing';

describe('billing live-mode detection', () => {
  it('flags a live publishable key', () => {
    const reasons = scanTextForLiveMode('Stripe("pk_live_aaaaaaaaaaaaaaaaaaaa")');
    expect(reasons.some((r) => r.includes('stripe-pk-live'))).toBe(true);
  });

  it('does NOT flag a test key', () => {
    expect(scanTextForLiveMode('Stripe("pk_test_aaaaaaaaaaaaaaaaaaaa")')).toHaveLength(0);
  });

  it('flags a live processor host', () => {
    const reasons = inspectRequestForLiveMode('https://www.paypal.com/checkout', null);
    expect(reasons.some((r) => r.startsWith('live-host:'))).toBe(true);
  });

  it('flags a live key in a stripe request body', () => {
    const reasons = inspectRequestForLiveMode(
      'https://api.stripe.com/v1/tokens',
      'key=pk_live_aaaaaaaaaaaaaaaaaaaa&card=1',
    );
    expect(reasons.some((r) => r.includes('live-key-in-request'))).toBe(true);
  });

  it('does not flag a sandbox paypal host', () => {
    expect(inspectRequestForLiveMode('https://www.sandbox.paypal.com/x', null)).toHaveLength(0);
  });

  it('recognizes payment hosts', () => {
    expect(isPaymentHost('api.stripe.com')).toBe(true);
    expect(isPaymentHost('example.com')).toBe(false);
  });
});

describe('isPaymentHost', () => {
  it('matches processor domains and their subdomains', () => {
    for (const host of [
      'api.stripe.com',
      'js.stripe.com',
      'm.stripe.network',
      'www.paypal.com',
      'www.sandbox.paypal.com',
      'www.paypalobjects.com',
      'api.braintreegateway.com',
      'payments.braintree-api.com',
      'checkoutshopper-live.adyen.com',
      'pci-connect.squareup.com',
      'connect.squareupsandbox.com',
      'web.squarecdn.com',
      'api.checkout.com',
      'api.sandbox.checkout.com',
    ]) {
      expect(isPaymentHost(host), host).toBe(true);
    }
  });

  it('does not match an app host that only contains a processor word', () => {
    for (const host of [
      'checkout.acme.test',
      'shop.paypal.example',
      'stripe.acme.test',
      'notstripe.com',
      'stripe.com.evil.test',
      'mycheckout.com',
    ]) {
      expect(isPaymentHost(host), host).toBe(false);
    }
  });

  it('only reads live keys from requests to Stripe itself', () => {
    const body = 'key=pk_live_aaaaaaaaaaaaaaaaaaaa';
    expect(inspectRequestForLiveMode('https://notstripe.com/v1/tokens', body)).toEqual([]);
    expect(inspectRequestForLiveMode('https://api.stripe.com/v1/tokens', body)).toEqual([
      'live-key-in-request:stripe-pk-live',
    ]);
  });
});

describe('key length bounds', () => {
  it('detects live keys longer than 99 chars (the old {10,99} matched nothing)', async () => {
    const { scanTextForLiveMode } = await import('../src/guardrails/billing');
    expect(scanTextForLiveMode('pk_live_' + 'a'.repeat(120)).length).toBeGreaterThan(0);
  });
});
