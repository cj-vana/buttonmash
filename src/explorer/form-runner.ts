/**
 * Complete one create-flow as a single macro-action: fill a form's fields with
 * valid data, click its SAFE submit, verify, and repair-and-resubmit on
 * validation failure. Safety is enforced here AND at gate time: payment/auth
 * forms and destructive submits are never submitted.
 */
import type { Locator } from 'playwright';

import type { ResolvedConfig } from '../config/load';
import { normalizeUrl } from '../core/hash';
import { compileRegexes } from '../core/regex';
import type { ElementDescriptor, FieldDescriptor, FormDescriptor } from '../core/types';
import { classifyControl } from '../guardrails/destructive';
import { addCanary } from '../detectors/page-checks';
import type { ActionContext } from './actions';
import { locate } from './discover';
import { valueForField } from './field-values';
import { assertUncovered } from './hit-test';

export interface FormResult {
  submitted: boolean;
  abandoned: boolean;
  navigated: boolean;
  fieldsFilled: number;
  retries: number;
  reason?: string;
}

/** True if this form must never be submitted (re-checked from gatePlan too). */
export function formIsUnsafe(form: FormDescriptor, cfg: ResolvedConfig): string | null {
  if (form.hasLivePaymentField) return 'payment field present';
  if (form.isAuthForm && !cfg.explore.forms.submitAuthForms) return 'auth/login form';
  const { extraVerbs, safeNames } = cfg.guardrails.destructive;
  if (form.submit && classifyControl(form.submit, extraVerbs, compileRegexes(safeNames)).block) {
    return 'destructive submit control';
  }
  return null;
}

async function fillField(
  ctx: ActionContext,
  field: FieldDescriptor,
  attempt: number,
): Promise<boolean> {
  const { page, cfg } = ctx;
  const t = cfg.budget.interactionTimeoutMs;
  const loc = locate(page, field.selector, field.frameUrl, field.frameIndex);
  const v = valueForField(ctx.runId, field, attempt);
  try {
    switch (field.kind) {
      case 'file':
        return false; // never upload
      case 'checkbox':
      case 'radio':
        await assertUncovered(loc, field.label || field.name || field.kind, t);
        await loc.setChecked(field.kind === 'radio' ? true : !!v.checked, {
          timeout: t,
          force: true,
        });
        break;
      case 'select':
        if (!v.value) return false;
        await loc.selectOption({ value: v.value }, { timeout: t }).catch(async () => {
          await loc.selectOption({ label: v.value }, { timeout: t }).catch(() => {});
        });
        break;
      case 'contenteditable':
        await loc.click({ timeout: t });
        await loc.pressSequentially(v.value.slice(0, 500), { timeout: t });
        break;
      default:
        await loc.fill(v.value.slice(0, 2000), { timeout: t });
    }
    if (v.canary) addCanary(ctx.state, v.canary);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count fields still invalid after a submit (the post-submit oracle), each read
 * in its own frame and shadow root. A field that is gone counts as valid (the
 * form was likely submitted); null means the page could not be read, so the
 * submit is not counted as a success.
 */
async function invalidCount(ctx: ActionContext, form: FormDescriptor): Promise<number | null> {
  let n = 0;
  for (const f of form.fields) {
    const loc = locate(ctx.page, f.selector, f.frameUrl, f.frameIndex);
    try {
      if ((await loc.count()) === 0) continue;
      const invalid = await loc.evaluate(
        (el) => {
          const field = el as HTMLElement & { validity?: ValidityState };
          return (
            field.getAttribute('aria-invalid') === 'true' ||
            (field.validity ? field.validity.valid === false : false)
          );
        },
        undefined,
        { timeout: 2_000 },
      );
      if (invalid) n++;
    } catch {
      return null;
    }
  }
  return n;
}

/**
 * Mark the classified submit control before any field is filled. Its nth-child
 * selector can point at a different control once filling inserts elements
 * ("Unsaved changes" ahead of the buttons), so the submit is clicked by this
 * mark, never by the selector again. Null if the control is gone or changed.
 */
async function pinSubmit(ctx: ActionContext, submit: ElementDescriptor): Promise<Locator | null> {
  const mark = `${ctx.runId}-${ctx.step}`;
  const tag = await locate(ctx.page, submit.selector, submit.frameUrl, submit.frameIndex)
    .evaluate(
      (el, value) => {
        el.setAttribute('data-bm-submit', value);
        return el.tagName.toLowerCase();
      },
      mark,
      { timeout: ctx.cfg.budget.interactionTimeoutMs },
    )
    .catch(() => null);
  if (tag !== submit.tag) return null;
  return locate(ctx.page, `[data-bm-submit="${mark}"]`, submit.frameUrl, submit.frameIndex);
}

/**
 * Submit through the pinned control: a click, or, when something covers it, the
 * form's own requestSubmit with that control as the submitter. Never Enter in a
 * field: that submits through the form's default button, which can be a
 * different control (a "Delete" ahead of "Save").
 */
async function submitVia(submit: Locator, timeout: number): Promise<boolean> {
  const clicked = await submit
    .click({ timeout, noWaitAfter: true })
    .then(() => true)
    .catch(() => false);
  if (clicked) return true;
  return submit
    .evaluate(
      (el) => {
        const button = el as HTMLButtonElement;
        if (!button.form || button.type !== 'submit') return false;
        button.form.requestSubmit(button);
        return true;
      },
      undefined,
      { timeout },
    )
    .catch(() => false);
}

export async function fillAndSubmit(ctx: ActionContext, form: FormDescriptor): Promise<FormResult> {
  const { page, rng, cfg } = ctx;
  const opts = cfg.explore.forms;
  const result: FormResult = {
    submitted: false,
    abandoned: false,
    navigated: false,
    fieldsFilled: 0,
    retries: 0,
  };

  const unsafe = formIsUnsafe(form, cfg);
  if (unsafe) {
    ctx.recorder.add(
      'guardrail',
      `skipped form (${unsafe}): ${form.submit?.name || form.formKey}`,
      {
        severity: 'info',
      },
    );
    result.abandoned = true;
    result.reason = unsafe;
    return result;
  }

  // Filling alone can save (change handlers, autosave), so a dry run stops here.
  if (cfg.guardrails.dryRun) {
    result.abandoned = true;
    result.reason = 'dry run';
    return result;
  }

  // Fields to fill: all required + a seeded fraction of optional.
  const fields = [...form.fields]
    .filter((f) => f.kind !== 'file' || !opts.skipFileUploads)
    .sort((a, b) => (a.required === b.required ? a.fp.localeCompare(b.fp) : a.required ? -1 : 1));

  const submit = form.submit && opts.submit ? await pinSubmit(ctx, form.submit) : null;
  if (opts.submit && !submit) {
    result.abandoned = true;
    result.reason = 'submit control changed before filling';
    return result;
  }

  const urlBefore = page.url();
  const maxAttempts = opts.maxRetries + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    result.retries = attempt;
    let filled = 0;
    for (const f of fields) {
      if (!f.required && !rng.bool(opts.fillOptionalProbability) && attempt === 0) continue;
      if (await fillField(ctx, f, attempt)) filled++;
    }
    result.fieldsFilled = filled;

    if (!submit) {
      result.abandoned = true;
      result.reason = 'submit disabled';
      return result;
    }

    if (!(await submitVia(submit, cfg.budget.interactionTimeoutMs))) {
      result.abandoned = true;
      result.reason = 'submit control not reachable';
      return result;
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
    result.navigated = normalizeUrl(urlBefore) !== normalizeUrl(page.url());
    if (result.navigated) {
      result.submitted = true;
      return result;
    }
    const invalid = await invalidCount(ctx, form);
    if (invalid === null) {
      result.reason = 'could not read the form after submitting';
      return result;
    }
    if (invalid === 0) {
      result.submitted = true;
      return result;
    }
    // else: validation failed — loop to repair with escalated values
  }

  ctx.recorder.add(
    'form-validation',
    `form not accepted after ${maxAttempts} attempts: ${form.submit?.name || form.formKey}`,
    {
      severity: 'low',
    },
  );
  result.reason = 'validation failed';
  return result;
}
