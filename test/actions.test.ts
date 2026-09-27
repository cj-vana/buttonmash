import { describe, expect, it } from 'vitest';
import { errors, type Page } from 'playwright';

import { loadConfig } from '../src/config/load';
import { Rng } from '../src/core/rng';
import type { ElementDescriptor } from '../src/core/types';
import { SignalRecorder } from '../src/detectors/recorder';
import { executeAction, type ActionContext } from '../src/explorer/actions';

/** A page whose only control is covered: every click waits out its timeout. */
function coveredPage(): Page {
  const locator = {
    first: () => locator,
    click: () => Promise.reject(new errors.TimeoutError('locator.click: Timeout 500ms exceeded.')),
    locator: () => ({ count: async () => 0 }),
    count: async () => 0,
    pressSequentially: async () => {},
  };
  return {
    url: () => 'http://app.test/editor',
    locator: () => locator,
  } as unknown as Page;
}

const control = (partial: Partial<ElementDescriptor>): ElementDescriptor => ({
  fp: 'c',
  structuralFp: 'c',
  tag: 'div',
  type: null,
  role: null,
  name: 'Notes',
  editable: false,
  path: 'div:0',
  selector: '#c',
  ...partial,
});

async function context(): Promise<ActionContext> {
  const cfg = await loadConfig({
    ignoreConfigFile: true,
    overrides: { target: 'http://app.test' },
  });
  return {
    page: coveredPage(),
    rng: new Rng('covered'),
    cfg,
    runId: 'covered',
    step: 0,
    state: { pendingCanaries: new Set(), seenBrokenImages: new Set() },
    recorder: new SignalRecorder(),
  };
}

describe('executeAction on a covered control', () => {
  it('surfaces the timeout when opening a custom combobox', async () => {
    const plan = { kind: 'select' as const, el: control({ role: 'combobox' }) };
    await expect(executeAction(await context(), plan)).rejects.toBeInstanceOf(errors.TimeoutError);
  });

  it('surfaces the timeout when focusing a contenteditable to type', async () => {
    const plan = { kind: 'type' as const, el: control({ editable: true }) };
    await expect(executeAction(await context(), plan)).rejects.toBeInstanceOf(errors.TimeoutError);
  });
});
