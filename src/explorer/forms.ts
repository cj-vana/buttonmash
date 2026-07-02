/**
 * Group discovered elements into "create surfaces" — clusters of fillable fields
 * with a submit control — and classify them. Pure (operates on serialized
 * descriptors), so it is unit-testable without a browser.
 *
 * Safety is structural: a form with a credit-card field or that looks like an
 * auth/login/signup form is flagged so the runner never submits it. The chosen
 * submit control is still re-checked through classifyControl at gate time.
 */
import { fnv1a } from '../core/hash';
import type { ElementDescriptor, FieldDescriptor, FormDescriptor } from '../core/types';
import { classifyControl, normalizeName } from '../guardrails/destructive';

const POSITIVE_SUBMIT = [
  'create',
  'add',
  'save',
  'submit',
  'next',
  'continue',
  'post',
  'send',
  'done',
  'finish',
  'apply',
  'insert',
  'new',
  'start',
  'generate',
];

const AUTH_RE = /sign ?in|sign ?up|log ?in|log ?on|register|create account|forgot|reset password|password/i;
const PAYMENT_RE = /\b(card|cc|cvc|cvv|cvc2|expir|security ?code|credit)\b/i;

function fieldKind(el: ElementDescriptor): FieldDescriptor['kind'] | null {
  if (el.editable) return 'contenteditable';
  const tag = el.tag;
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    const t = (el.type ?? 'text').toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'hidden'].includes(t)) return null;
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'email') return 'email';
    if (t === 'number') return 'number';
    if (t === 'range') return 'range';
    if (t === 'tel') return 'tel';
    if (t === 'url') return 'url';
    if (t === 'password') return 'password';
    if (t === 'color') return 'color';
    if (t === 'file') return 'file';
    // Keep the exact type: each has its own value format, and fill() throws
    // "Malformed value" on a plain YYYY-MM-DD in a datetime-local/month/week/time.
    if (t === 'date' || t === 'datetime-local' || t === 'month' || t === 'week' || t === 'time') return t;
    return 'text';
  }
  if (el.role === 'textbox') return 'text';
  return null;
}

function toField(el: ElementDescriptor): FieldDescriptor | null {
  const kind = fieldKind(el);
  if (!kind) return null;
  return {
    selector: el.selector,
    fp: el.fp,
    kind,
    name: el.name || '',
    label: el.label || '',
    placeholder: el.placeholder || '',
    required: !!el.required,
    pattern: el.pattern,
    min: el.min,
    max: el.max,
    step: el.step,
    minLength: el.minLength,
    maxLength: el.maxLength,
    autocomplete: el.autocomplete,
    options: el.options,
    radioGroupName: el.tag === 'input' && el.type === 'radio' ? el.name : undefined,
    formKey: el.formKey || 'page',
    frameUrl: el.frameUrl,
  };
}

/** Create-intent score for a button-like control (0..1). Destructive wins → 0. */
export function scorePrimaryAction(el: ElementDescriptor, extraVerbs: readonly string[] = []): number {
  if (classifyControl(el, []).block) return 0;
  if (el.isSubmit) return 0.9;
  const name = normalizeName(el.name);
  if (!name) return el.role === 'button' || el.tag === 'button' ? 0.2 : 0;
  const verbs = [...POSITIVE_SUBMIT, ...extraVerbs.map((v) => normalizeName(v))];
  for (const v of verbs) if (name === v || name.startsWith(v + ' ') || name.includes(' ' + v)) return 0.8;
  if (/^\+|^add|^new/.test(name)) return 0.7;
  return 0;
}

function isSubmitCandidate(el: ElementDescriptor): boolean {
  if (el.disabled) return false;
  if (el.isSubmit) return true;
  return (el.tag === 'button' || el.role === 'button') && scorePrimaryAction(el) >= 0.7;
}

/** Group elements into create-surfaces keyed by their owning form/dialog scope. */
export function groupForms(
  elements: readonly ElementDescriptor[],
  extraVerbs: readonly string[] = [],
): FormDescriptor[] {
  const byScope = new Map<string, ElementDescriptor[]>();
  for (const el of elements) {
    const key = el.formKey || 'page';
    (byScope.get(key) ?? byScope.set(key, []).get(key)!).push(el);
  }

  const forms: FormDescriptor[] = [];
  for (const [formKey, group] of byScope) {
    const fields = group.map(toField).filter((f): f is FieldDescriptor => f !== null);
    if (fields.length === 0) continue;

    const submits = group.filter(isSubmitCandidate).sort((a, b) => {
      const s = scorePrimaryAction(b, extraVerbs) - scorePrimaryAction(a, extraVerbs);
      return s !== 0 ? s : a.fp.localeCompare(b.fp);
    });
    const submit = submits[0];
    if (!submit) continue; // no safe submit → not a completable create-surface

    const nextControls = group.filter((el) => /next|continue/i.test(el.name) && !el.disabled);
    const haystack = group.map((el) => `${el.name} ${el.label ?? ''} ${el.autocomplete ?? ''}`).join(' ');
    const hasLivePaymentField = group.some(
      (el) => PAYMENT_RE.test(`${el.name} ${el.label ?? ''}`) || (el.autocomplete ?? '').startsWith('cc-'),
    );
    const hasPassword = fields.some((f) => f.kind === 'password');
    const isAuthForm = hasPassword || AUTH_RE.test(`${submit.name} ${haystack}`);

    const fpKey = fnv1a(formKey + '|' + fields.map((f) => f.fp).sort().join(','));
    forms.push({ formKey, fpKey, fields, submit, nextControls, hasLivePaymentField, isAuthForm });
  }
  return forms;
}
