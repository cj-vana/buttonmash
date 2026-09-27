import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';

import { loadConfig, type ResolvedConfig } from '../src/config/load';
import { addCanary, runPageChecks, type DetectorState } from '../src/detectors/page-checks';
import { SignalRecorder } from '../src/detectors/recorder';

let cfg: ResolvedConfig;
let recorder: SignalRecorder;
let state: DetectorState;

beforeEach(async () => {
  cfg = await loadConfig({
    ignoreConfigFile: true,
    overrides: { target: 'https://app.test', guardrails: { billing: { mode: 'refuse' } } },
  });
  recorder = new SignalRecorder();
  recorder.setContext(3, 'https://app.test/projects');
  state = { pendingCanaries: new Set(['BM_CANARY']), seenBrokenImages: new Set() };
});

describe('page checks', () => {
  it('records structural, content, custom, billing, secret, and reflection signals', async () => {
    const html =
      '<main><div>BM_CANARY</div><p>sk_live_abcdefghijklmnop</p>' +
      '<script>pk_live_abcdefghijklmnop</script></main>';
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        blank: true,
        brokenImages: ['https://app.test/broken.png', 'https://app.test/broken.png'],
        overlay: 'vite-error-overlay',
      })
      .mockResolvedValueOnce('{}');
    const page = {
      evaluate,
      content: vi.fn().mockResolvedValue(html),
      $$eval: vi.fn().mockResolvedValue('pk_live_abcdefghijklmnop'),
      url: vi.fn().mockReturnValue('https://app.test/projects?mode=preview'),
    } as unknown as Page;
    const markBillingLive = vi.fn();

    await runPageChecks(
      {
        page,
        recorder,
        cfg,
        state,
        markBillingLive,
        customDom: [{ name: 'preview marker', re: /BM_CANARY/, severity: 'medium' }],
        customUrl: [{ name: 'preview url', re: /mode=preview/, severity: 'low' }],
        timeLeftMs: 10_000,
      },
      true,
    );

    const kinds = recorder.signals.map((signal) => signal.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'blank-screen',
        'broken-image',
        'error-overlay',
        'billing-live',
        'secret-leak',
        'reflected-input',
        'custom',
      ]),
    );
    expect(kinds.filter((kind) => kind === 'broken-image')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'custom')).toHaveLength(2);
    expect(markBillingLive).toHaveBeenCalledWith(
      expect.arrayContaining(['live-key-in-page:stripe-pk-live']),
    );
    expect(state.pendingCanaries).not.toContain('BM_CANARY');
    expect(state.seenBrokenImages).toContain('https://app.test/broken.png');
  });

  it('runs only cheap structural and URL checks for an existing state', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({ blank: false, brokenImages: [], overlay: null }),
      content: vi.fn(),
      $$eval: vi.fn(),
      url: vi.fn().mockReturnValue('https://app.test/warning'),
    } as unknown as Page;

    await runPageChecks(
      {
        page,
        recorder,
        cfg,
        state,
        markBillingLive: vi.fn(),
        customDom: [],
        customUrl: [{ name: 'warning route', re: /warning/, severity: 'low' }],
        timeLeftMs: 60_000,
      },
      false,
    );

    expect(recorder.signals.map((signal) => signal.kind)).toEqual(['custom']);
    expect(page.content).not.toHaveBeenCalled();
  });

  /** A new-state check over `html` with the structural probe reporting nothing. */
  async function contentCheck(html: string): Promise<void> {
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ blank: false, brokenImages: [], overlay: null })
        .mockResolvedValueOnce(''),
      content: vi.fn().mockResolvedValue(html),
      $$eval: vi.fn().mockResolvedValue(''),
      url: vi.fn().mockReturnValue('https://app.test/search'),
    } as unknown as Page;
    await runPageChecks(
      {
        page,
        recorder,
        cfg,
        state,
        markBillingLive: vi.fn(),
        customDom: [],
        customUrl: [],
        timeLeftMs: 10_000,
      },
      true,
    );
  }

  it('checks every occurrence of a canary, not just an attribute echo that comes first', async () => {
    await contentCheck(
      '<form><input name="q" value="BM_CANARY"></form><h1>Results for BM_CANARY</h1>',
    );
    const reflected = recorder.signals.filter((s) => s.kind === 'reflected-input');
    expect(reflected).toHaveLength(1);
    expect(reflected[0]!.severity).toBe('low');
    expect(reflected[0]!.detail).toContain('<h1>Results for BM_CANARY</h1>');
    expect(state.pendingCanaries.has('BM_CANARY')).toBe(false);
  });

  it('drops a canary that only ever appears in safe contexts', async () => {
    await contentCheck('<input value="BM_CANARY"><textarea>BM_CANARY</textarea>');
    expect(recorder.signals.filter((s) => s.kind === 'reflected-input')).toEqual([]);
    expect(state.pendingCanaries.has('BM_CANARY')).toBe(false);
  });

  it('keeps a secret cut by the context window out of the reflection detail', async () => {
    const token = 'ghp_' + 'Q7w9E2r4T6y8U1i3O5p7A9s2D4f6G8h1J3k5';
    await contentCheck(`<p>BM_CANARY</p><span data-k="${token}"></span>`);
    const [reflected] = recorder.signals.filter((s) => s.kind === 'reflected-input');
    expect(reflected?.detail).toBeDefined();
    expect(reflected!.detail).not.toContain(token.slice(0, 10));
  });

  it('returns cleanly when the structural probe cannot run', async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error('page navigating')),
    } as unknown as Page;

    await expect(
      runPageChecks(
        {
          page,
          recorder,
          cfg,
          state,
          markBillingLive: vi.fn(),
          customDom: [],
          customUrl: [],
          timeLeftMs: 60_000,
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(recorder.signals).toHaveLength(0);
  });

  it('reports serious and critical axe violations when a11y is enabled', async () => {
    cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: { target: 'https://app.test', detectors: { a11y: true } },
    });
    const evaluate = vi
      .fn()
      // domCheck → globals probe → axe inject → axe run
      .mockResolvedValueOnce({ blank: false, brokenImages: [], overlay: null })
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        violations: [
          {
            id: 'button-name',
            help: 'Buttons must have discernible text',
            impact: 'critical',
            nodes: [{}],
          },
          {
            id: 'color-contrast',
            help: 'Elements must meet contrast ratio',
            impact: 'serious',
            nodes: [{}, {}],
          },
          { id: 'region', help: 'Content should be in landmarks', impact: 'moderate', nodes: [{}] },
        ],
      });
    const page = {
      evaluate,
      content: vi.fn().mockResolvedValue('<main>fine</main>'),
      $$eval: vi.fn().mockResolvedValue(''),
      url: vi.fn().mockReturnValue('https://app.test/'),
    } as unknown as Page;

    await runPageChecks(
      {
        page,
        recorder,
        cfg,
        state,
        markBillingLive: vi.fn(),
        customDom: [],
        customUrl: [],
        timeLeftMs: 60_000,
      },
      true,
    );

    const a11y = recorder.signals.filter((signal) => signal.kind === 'a11y');
    expect(a11y).toHaveLength(2);
    expect(a11y[0].severity).toBe('high');
    expect(a11y[0].detail).toContain('button-name');
    expect(a11y[1].severity).toBe('medium');
    expect(a11y[1].detail).toContain('color-contrast');
  });

  it('skips the axe scan when the remaining time budget is low', async () => {
    cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: { target: 'https://app.test', detectors: { a11y: true } },
    });
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ blank: false, brokenImages: [], overlay: null })
      .mockResolvedValueOnce('');
    const page = {
      evaluate,
      content: vi.fn().mockResolvedValue('<main>fine</main>'),
      $$eval: vi.fn().mockResolvedValue(''),
      url: vi.fn().mockReturnValue('https://app.test/'),
    } as unknown as Page;

    await runPageChecks(
      {
        page,
        recorder,
        cfg,
        state,
        markBillingLive: vi.fn(),
        customDom: [],
        customUrl: [],
        timeLeftMs: 10_000,
      },
      true,
    );

    expect(recorder.signals.filter((signal) => signal.kind === 'a11y')).toHaveLength(0);
    // domCheck + globals probe only; no axe inject/run calls.
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});

describe('addCanary', () => {
  it('tracks canaries and evicts the oldest beyond the bound', () => {
    const s: DetectorState = { pendingCanaries: new Set(), seenBrokenImages: new Set() };
    for (let i = 0; i < 200; i++) addCanary(s, `bm-${i}`);
    expect(s.pendingCanaries.size).toBe(200);

    addCanary(s, 'bm-newest');
    expect(s.pendingCanaries.size).toBe(200);
    expect(s.pendingCanaries.has('bm-0')).toBe(false);
    expect(s.pendingCanaries.has('bm-1')).toBe(true);
    expect(s.pendingCanaries.has('bm-newest')).toBe(true);
  });
});
