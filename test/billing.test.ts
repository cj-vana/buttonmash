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

describe('PayPal live mode', () => {
  const live = (url: string) => inspectRequestForLiveMode(url, null);

  it('treats an SDK load with a sandbox client id as sandbox', () => {
    // paypal-js loads www.paypal.com/sdk/js unless told environment: "sandbox".
    expect(live('https://www.paypal.com/sdk/js?client-id=sb&currency=USD')).toEqual([]);
    expect(live('https://www.paypal.com/sdk/js?client-id=test&components=buttons')).toEqual([]);
  });

  it('treats an SDK load with any other client id as live', () => {
    const id = 'AZDxjDScFpQtjWTOUtWKbyN_bDt4OgqaF4eYXlewfBP4-8aqX3PiV8e1GWU6liB2CUXlkA59kJXE7M6R';
    expect(live(`https://www.paypal.com/sdk/js?client-id=${id}`)).toEqual([
      'live-host:www.paypal.com',
    ]);
    expect(live('https://www.paypal.com/sdk/js?currency=USD')).toEqual([
      'live-host:www.paypal.com',
    ]);
    // The v6 SDK picks its environment by host, so the live host means live.
    expect(live('https://www.paypal.com/web-sdk/v6/core')).toEqual(['live-host:www.paypal.com']);
  });

  it('treats order and checkout paths on www.paypal.com as live', () => {
    for (const path of [
      '/checkoutnow?token=EC-1AB23456CD789012E',
      '/v2/checkout/orders',
      '/smart/api/order/5O190127TN364715T/capture',
      '/cgi-bin/webscr',
    ]) {
      expect(live(`https://www.paypal.com${path}`), path).toEqual(['live-host:www.paypal.com']);
    }
  });

  it('does not treat the buttons frame or the sandbox host as live', () => {
    expect(live('https://www.paypal.com/smart/buttons?env=sandbox&clientID=sb')).toEqual([]);
    expect(live('https://www.sandbox.paypal.com/checkoutnow?token=EC-1')).toEqual([]);
    expect(live('https://www.sandbox.paypal.com/v2/checkout/orders')).toEqual([]);
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
