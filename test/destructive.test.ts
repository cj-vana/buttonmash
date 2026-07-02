import { describe, it, expect } from 'vitest';
import { classifyControl, normalizeName } from '../src/guardrails/destructive';
import type { ElementDescriptor } from '../src/core/types';

function el(partial: Partial<ElementDescriptor>): ElementDescriptor {
  return {
    fp: 'x',
    structuralFp: 'x',
    tag: 'button',
    type: null,
    role: null,
    name: '',
    editable: false,
    path: '',
    selector: 'button',
    ...partial,
  };
}

describe('destructive classifier', () => {
  it('blocks delete / pay / logout by name', () => {
    expect(classifyControl(el({ name: 'Delete account' })).block).toBe(true);
    expect(classifyControl(el({ name: 'Pay now' })).block).toBe(true);
    expect(classifyControl(el({ name: 'Log out' })).block).toBe(true);
    expect(classifyControl(el({ name: 'Cancel subscription' })).block).toBe(true);
  });

  it('allows benign controls', () => {
    expect(classifyControl(el({ name: 'Save draft' })).block).toBe(false);
    expect(classifyControl(el({ name: 'Next' })).block).toBe(false);
    expect(classifyControl(el({ name: '' })).block).toBe(false);
  });

  it('blocks by dangerous href even with no text', () => {
    expect(classifyControl(el({ tag: 'a', name: '', href: '/account/delete' })).block).toBe(true);
    expect(classifyControl(el({ tag: 'a', name: '', href: '/logout' })).block).toBe(true);
  });

  it('honors extra verbs and multilingual matches', () => {
    expect(classifyControl(el({ name: 'Eliminar' })).block).toBe(true);
    expect(classifyControl(el({ name: 'Abmelden' })).block).toBe(true);
    expect(classifyControl(el({ name: 'Nuke it' }), ['nuke']).block).toBe(true);
  });

  it('normalizeName strips accents and punctuation', () => {
    expect(normalizeName('  Élïmïnär! ')).toBe('eliminar');
  });
});

describe('verb matching precision', () => {
  it('blocks non-Latin destructive verbs (used to normalize to empty)', () => {
    expect(classifyControl(el({ name: '削除' })).block).toBe(true); // ja: delete
    expect(classifyControl(el({ name: 'Удалить файл' })).block).toBe(true); // ru: delete
    expect(classifyControl(el({ name: 'حذف' })).block).toBe(true); // ar: delete
    expect(classifyControl(el({ name: '로그아웃' })).block).toBe(true); // ko: logout
    expect(classifyControl(el({ name: '删除项目' })).block).toBe(true); // zh: delete item
  });

  it('does not block benign names containing a verb as a substring', () => {
    expect(classifyControl(el({ name: 'Banner settings' })).block).toBe(false); // not "ban"
    expect(classifyControl(el({ name: 'Urban planning' })).block).toBe(false); // not "ban"
    expect(classifyControl(el({ name: 'Buyer profile' })).block).toBe(false); // not "buy"
    expect(classifyControl(el({ name: 'PayPal login' })).block).toBe(false); // not "pay"
  });

  it('still blocks common inflections of longer verbs', () => {
    expect(classifyControl(el({ name: 'Removes item' })).block).toBe(true);
    expect(classifyControl(el({ name: 'Archived' })).block).toBe(true);
    expect(classifyControl(el({ name: 'Deletes everything' })).block).toBe(true);
  });

  it('accepts non-Latin extraVerbs', () => {
    expect(classifyControl(el({ name: '送信する' }), ['送信']).block).toBe(true);
  });
});
