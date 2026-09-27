/**
 * The fence's payment decisions, driven through its real route handler with
 * a fake context so no request leaves the machine (a real browser would load
 * the PayPal SDK from paypal.com whenever the fence lets it through).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext, Page, Request, Route } from 'playwright';

import { loadConfig, type ResolvedConfig } from '../src/config/load';
import { SignalRecorder } from '../src/detectors/recorder';
import { attachSignalListeners } from '../src/detectors/signals';
import { FenceLog, installContextFence, type FenceOptions } from '../src/guardrails/fence';

type Handler = (route: Route) => unknown;

function fakeRequest(url: string, resourceType = 'script'): Request {
  return {
    url: () => url,
    resourceType: () => resourceType,
    postData: () => null,
  } as unknown as Request;
}

let cfg: ResolvedConfig;
let recorder: SignalRecorder;
let routeHandler: Handler;
let requestListener: (req: Request) => void;
let latched: string[];

async function setup(overrides: Partial<FenceOptions> = {}): Promise<void> {
  const context = {
    on: () => {},
    route: async (_url: string, handler: Handler) => {
      routeHandler = handler;
    },
    routeWebSocket: async () => {},
    browser: () => null,
  } as unknown as BrowserContext;
  const opts: FenceOptions = {
    allowedOrigins: ['https://shop.test'],
    blockedPathRe: null,
    blockMedia: false,
    billingMode: 'refuse',
    isBillingLatched: () => latched.length > 0,
    aborted: new FenceLog(),
    ...overrides,
  };
  await installContextFence(context, opts, recorder);
  const page = {
    on: (event: string, fn: (req: Request) => void) => {
      if (event === 'request') requestListener = fn;
    },
  } as unknown as Page;
  attachSignalListeners({
    page,
    recorder,
    cfg,
    ignore: [],
    customConsole: [],
    onBillingLive: (reasons) => {
      latched = reasons;
    },
    fenced: opts.aborted!,
  });
}

/** What the browser does for one request: fire `request`, then route it. */
async function send(url: string, resourceType = 'script'): Promise<string> {
  const req = fakeRequest(url, resourceType);
  let outcome = 'none';
  const route = {
    request: () => req,
    abort: async () => {
      outcome = 'aborted';
    },
    continue: async () => {
      outcome = 'continued';
    },
  } as unknown as Route;
  requestListener(req);
  await routeHandler(route);
  return outcome;
}

beforeEach(async () => {
  cfg = await loadConfig({ ignoreConfigFile: true, overrides: { target: 'https://shop.test' } });
  recorder = new SignalRecorder();
  latched = [];
});

describe('fence payment decisions', () => {
  it('lets a sandbox PayPal SDK load through without latching live billing', async () => {
    await setup();
    expect(await send('https://www.paypal.com/sdk/js?client-id=sb&currency=USD')).toBe('continued');
    expect(latched).toEqual([]);
    expect(recorder.signals).toEqual([]);
  });

  it('blocks a live PayPal checkout and records it once', async () => {
    await setup();
    expect(await send('https://www.paypal.com/checkoutnow?token=EC-1', 'document')).toBe('aborted');
    expect(latched).toEqual(['live-host:www.paypal.com']);
    expect(recorder.signals.map((s) => `${s.kind}/${s.severity}: ${s.detail}`)).toEqual([
      'billing-live/critical: live-host:www.paypal.com',
    ]);
  });

  it('after a latch, blocks sandbox payment requests too and records each block', async () => {
    await setup({ billingMode: 'warn' });
    latched = ['live-key-in-page:stripe-pk-live'];
    expect(await send('https://www.sandbox.paypal.com/v2/checkout/orders', 'fetch')).toBe(
      'aborted',
    );
    expect(recorder.signals.map((s) => `${s.kind}/${s.severity}: ${s.detail}`)).toEqual([
      'billing-live/medium: blocked a payment request to www.sandbox.paypal.com after live billing was detected',
    ]);
  });

  it("does not treat the app's own checkout host as a payment host", async () => {
    await setup({ allowedOrigins: ['https://checkout.acme.test'], billingMode: 'warn' });
    latched = ['live-key-in-page:stripe-pk-live'];
    expect(await send('https://checkout.acme.test/api/cart', 'fetch')).toBe('continued');
  });
});
