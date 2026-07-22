import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';

import { awaitPageReady } from '../src/explorer/readiness';

afterEach(() => {
  vi.unstubAllGlobals();
});

function pageThatEvaluatesProbe() {
  return {
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn(async (probe: (selector: string) => boolean, selector: string) => {
      if (!probe(selector)) throw new Error('not ready');
    }),
  } as unknown as Page;
}

describe('page readiness', () => {
  it('accepts a light-DOM interactive control', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn((selector: string) => (selector === '*' ? [] : [{}])),
      querySelector: vi.fn().mockReturnValue(null),
    });
    const page = pageThatEvaluatesProbe();

    await awaitPageReady(page, 100);
    expect(page.waitForLoadState).toHaveBeenCalledWith('load');
    expect(page.waitForFunction).toHaveBeenCalledOnce();
  });

  it('accepts iframe and open-shadow-root applications', async () => {
    const querySelectorAll = vi.fn((selector: string) =>
      selector === '*' ? [{ shadowRoot: {} }] : [],
    );
    vi.stubGlobal('document', {
      querySelectorAll,
      querySelector: vi.fn().mockReturnValue({ tagName: 'IFRAME' }),
    });
    await awaitPageReady(pageThatEvaluatesProbe(), 100);

    vi.stubGlobal('document', {
      querySelectorAll,
      querySelector: vi.fn().mockReturnValue(null),
    });
    await awaitPageReady(pageThatEvaluatesProbe(), 100);
    expect(querySelectorAll).toHaveBeenCalledWith('*');
  });

  it('treats load and probe errors as bounded best-effort waits', async () => {
    const page = {
      waitForLoadState: vi.fn().mockRejectedValue(new Error('load timeout')),
      waitForFunction: vi.fn().mockRejectedValue(new Error('probe timeout')),
    } as unknown as Page;
    await expect(awaitPageReady(page, 1)).resolves.toBeUndefined();
  });
});
