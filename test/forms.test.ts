import { describe, it, expect } from 'vitest';
import { groupForms, scorePrimaryAction } from '../src/explorer/forms';
import type { ElementDescriptor } from '../src/core/types';

let n = 0;
function el(over: Partial<ElementDescriptor>): ElementDescriptor {
  return {
    fp: `fp${n++}`,
    structuralFp: `sfp${n}`,
    tag: 'input',
    type: 'text',
    role: null,
    name: '',
    editable: false,
    path: 'p',
    selector: `#e${n}`,
    formKey: 'F1',
    ...over,
  };
}

describe('scorePrimaryAction', () => {
  it('ranks create/save/submit high and destructive at zero', () => {
    expect(scorePrimaryAction(el({ tag: 'button', name: 'Create' }))).toBeGreaterThanOrEqual(0.7);
    expect(scorePrimaryAction(el({ tag: 'button', name: 'Save changes' }))).toBeGreaterThanOrEqual(
      0.7,
    );
    expect(scorePrimaryAction(el({ tag: 'button', name: 'Add row' }))).toBeGreaterThanOrEqual(0.7);
    expect(scorePrimaryAction(el({ tag: 'button', name: 'Delete' }))).toBe(0);
    expect(scorePrimaryAction(el({ tag: 'button', name: 'Log out' }))).toBe(0);
  });

  it('treats type=submit as a strong submit', () => {
    expect(scorePrimaryAction(el({ tag: 'button', isSubmit: true, name: '' }))).toBeGreaterThan(
      0.5,
    );
  });
});

describe('groupForms', () => {
  it('detects a create-surface with a non-destructive submit', () => {
    const forms = groupForms([
      el({ formKey: 'F1', name: 'name', type: 'text', required: true }),
      el({ formKey: 'F1', name: 'email', type: 'email', required: true }),
      el({ formKey: 'F1', tag: 'button', type: 'submit', isSubmit: true, name: 'Create item' }),
    ]);
    expect(forms).toHaveLength(1);
    expect(forms[0]!.fields).toHaveLength(2);
    expect(forms[0]!.submit?.name).toBe('Create item');
    expect(forms[0]!.isAuthForm).toBe(false);
    expect(forms[0]!.hasLivePaymentField).toBe(false);
  });

  it('picks the non-destructive submit when a destructive button is nearby', () => {
    const forms = groupForms([
      el({ formKey: 'F2', name: 'title', type: 'text' }),
      el({ formKey: 'F2', tag: 'button', name: 'Delete all' }),
      el({ formKey: 'F2', tag: 'button', type: 'submit', isSubmit: true, name: 'Save' }),
    ]);
    expect(forms[0]!.submit?.name).toBe('Save');
  });

  it('flags auth forms (password present) and never picks them by default', () => {
    const forms = groupForms([
      el({ formKey: 'F3', name: 'email', type: 'email' }),
      el({ formKey: 'F3', name: 'password', type: 'password' }),
      el({ formKey: 'F3', tag: 'button', type: 'submit', isSubmit: true, name: 'Sign in' }),
    ]);
    expect(forms[0]!.isAuthForm).toBe(true);
  });

  it('flags payment forms (card fields)', () => {
    const forms = groupForms([
      el({ formKey: 'F4', name: 'cardNumber', type: 'text', autocomplete: 'cc-number' }),
      el({ formKey: 'F4', tag: 'button', type: 'submit', isSubmit: true, name: 'Pay' }),
    ]);
    expect(forms[0]!.hasLivePaymentField).toBe(true);
  });

  it('ignores scopes with no fillable fields', () => {
    const forms = groupForms([
      el({ formKey: 'F5', tag: 'button', name: 'New' }),
      el({ formKey: 'F5', tag: 'button', name: 'Delete all' }),
    ]);
    expect(forms).toHaveLength(0);
  });
});
