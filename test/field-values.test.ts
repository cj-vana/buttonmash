import { describe, it, expect } from 'vitest';
import { valueForField } from '../src/explorer/field-values';
import type { FieldDescriptor } from '../src/core/types';

function field(over: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    selector: '#x',
    fp: 'fp0',
    kind: 'text',
    name: '',
    label: '',
    placeholder: '',
    required: false,
    formKey: 'F',
    ...over,
  };
}

describe('valueForField', () => {
  it('is deterministic for a given runId + field', () => {
    const f = field({ kind: 'email', name: 'email' });
    expect(valueForField('run', f)).toEqual(valueForField('run', f));
  });

  it('produces a valid email for email fields', () => {
    expect(valueForField('run', field({ kind: 'email', name: 'email' })).value).toMatch(/^[^@\s]+@[^@\s]+$/);
  });

  it('clamps numbers to [min,max]', () => {
    const v = Number(valueForField('run', field({ kind: 'number', min: '5', max: '9' })).value);
    expect(v).toBeGreaterThanOrEqual(5);
    expect(v).toBeLessThanOrEqual(9);
  });

  it('respects maxLength', () => {
    const v = valueForField('run', field({ kind: 'text', name: 'description', maxLength: 6 })).value;
    expect(v.length).toBeLessThanOrEqual(6);
  });

  it('picks a non-empty, non-disabled select option', () => {
    const v = valueForField(
      'run',
      field({
        kind: 'select',
        options: [
          { value: '', label: 'Choose', disabled: false },
          { value: 'audio', label: 'Audio', disabled: false },
          { value: 'video', label: 'Video', disabled: true },
        ],
      }),
    ).value;
    expect(v).toBe('audio');
  });

  it('mirrors all password fields in a form to one value (confirm matches)', () => {
    const pw = field({ kind: 'password', name: 'password', formKey: 'F' });
    const confirm = field({ kind: 'password', name: 'confirmPassword', formKey: 'F', selector: '#c' });
    expect(valueForField('run', pw).value).toBe(valueForField('run', confirm).value);
  });

  it('generates a seed-derived (not wall-clock) ISO date, stable per seed', () => {
    const v1 = valueForField('run', field({ kind: 'date', name: 'when' })).value;
    const v2 = valueForField('run', field({ kind: 'date', name: 'when' })).value;
    expect(v1).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v1).toBe(v2);
  });

  it('embeds a reflected-input canary in free-text/textarea values', () => {
    const r = valueForField('run', field({ kind: 'textarea', name: 'notes' }));
    expect(r.canary).toMatch(/^cnry[0-9a-f]{8}zz$/);
    expect(r.value).toContain(r.canary!);
  });
});

describe('date-family formats', () => {
  const base = {
    selector: 'input',
    fp: 'x',
    name: 'when',
    label: '',
    placeholder: '',
    required: true,
    formKey: 'f',
  } as const;

  it('emits the exact value format each input type requires', () => {
    expect(valueForField('run', { ...base, kind: 'date' }).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(valueForField('run', { ...base, kind: 'datetime-local' }).value).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
    expect(valueForField('run', { ...base, kind: 'month' }).value).toMatch(/^\d{4}-\d{2}$/);
    expect(valueForField('run', { ...base, kind: 'week' }).value).toMatch(/^\d{4}-W\d{2}$/);
    expect(valueForField('run', { ...base, kind: 'time' }).value).toMatch(/^\d{2}:\d{2}$/);
  });

  it('number step snapping never overshoots max', () => {
    for (let i = 0; i < 20; i++) {
      const v = Number(
        valueForField(`run${i}`, { ...base, kind: 'number', min: '0', max: '10', step: '4' }).value,
      );
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
    }
  });
});
