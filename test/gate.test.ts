import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/load';
import type { ElementDescriptor, FormDescriptor } from '../src/core/types';
import { SignalRecorder } from '../src/detectors/recorder';
import { gatePlan } from '../src/explorer/actions';
import { formIsUnsafe } from '../src/explorer/form-runner';

const resetZoom: ElementDescriptor = {
  fp: 'reset-zoom',
  structuralFp: 'reset-zoom',
  tag: 'button',
  type: null,
  role: null,
  name: 'Reset zoom',
  editable: false,
  path: 'button:0',
  selector: '#reset-zoom',
};

const config = (safeNames: string[]) =>
  loadConfig({
    ignoreConfigFile: true,
    overrides: { target: 'https://x.test', guardrails: { destructive: { safeNames } } },
  });

describe('gatePlan with destructive safe names', () => {
  it('downgrades a verb-matching control to hover by default', async () => {
    const recorder = new SignalRecorder();
    const plan = gatePlan({ kind: 'click', el: resetZoom }, await config([]), recorder);
    expect(plan.kind).toBe('hover');
    expect(recorder.signals[0]?.detail).toContain('verb:reset');
  });

  it('clicks a control named by a safe-name pattern', async () => {
    const recorder = new SignalRecorder();
    const plan = gatePlan(
      { kind: 'click', el: resetZoom },
      await config(['^reset zoom$']),
      recorder,
    );
    expect(plan.kind).toBe('click');
    expect(recorder.signals).toHaveLength(0);
  });

  it('applies the same exemption to a form submit control', async () => {
    const form: FormDescriptor = {
      formKey: 'zoom',
      fpKey: 'zoom',
      fields: [],
      submit: { ...resetZoom, isSubmit: true },
      nextControls: [],
      hasLivePaymentField: false,
      isAuthForm: false,
    };
    expect(formIsUnsafe(form, await config([]))).toBe('destructive submit control');
    expect(formIsUnsafe(form, await config(['^reset zoom$']))).toBeNull();
  });
});
