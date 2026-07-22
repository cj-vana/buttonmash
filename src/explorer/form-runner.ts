/**
 * Complete one create-flow as a single macro-action: fill a form's fields with
 * valid data, click its SAFE submit, verify, and repair-and-resubmit on
 * validation failure. Safety is enforced here AND at gate time: payment/auth
 * forms and destructive submits are never submitted.
 */
import type { ResolvedConfig } from '../config/load';
import { withDeadline } from '../core/async';
import { normalizeUrl } from '../core/hash';
import type { FieldDescriptor, FormDescriptor } from '../core/types';
import { classifyControl } from '../guardrails/destructive';
import { addCanary } from '../detectors/page-checks';
import type { ActionContext } from './actions';
import { locate } from './discover';
import { valueForField } from './field-values';

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
  if (form.submit && classifyControl(form.submit, cfg.guardrails.destructive.extraVerbs).block) {
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
  const loc = locate(page, field.selector, field.frameUrl);
  const v = valueForField(ctx.runId, field, attempt);
  try {
    switch (field.kind) {
      case 'file':
        return false; // never upload
      case 'checkbox':
      case 'radio':
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
        await loc.click({ timeout: t }).catch(() => {});
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

/** Count fields still invalid within the form's scope (post-submit oracle). */
async function invalidCount(ctx: ActionContext, form: FormDescriptor): Promise<number> {
  try {
    return await withDeadline(
      ctx.page.evaluate(
        (selectors: string[]) => {
          let n = 0;
          for (const sel of selectors) {
            const el = document.querySelector(sel) as
              | (HTMLElement & { validity?: ValidityState })
              | null;
            if (!el) continue; // gone (likely submitted/navigated) → not invalid
            const ariaInvalid = el.getAttribute('aria-invalid') === 'true';
            const nativeInvalid = el.validity ? el.validity.valid === false : false;
            if (ariaInvalid || nativeInvalid) n++;
          }
          return n;
        },
        form.fields.map((f) => f.selector),
      ),
      5_000,
      'form-verify',
    );
  } catch {
    return 0;
  }
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

  // Fields to fill: all required + a seeded fraction of optional.
  const fields = [...form.fields]
    .filter((f) => f.kind !== 'file' || !opts.skipFileUploads)
    .sort((a, b) => (a.required === b.required ? a.fp.localeCompare(b.fp) : a.required ? -1 : 1));

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

    if (cfg.guardrails.dryRun || !opts.submit) {
      result.abandoned = true;
      result.reason = cfg.guardrails.dryRun ? 'dry-run (filled, not submitted)' : 'submit disabled';
      return result;
    }

    // Submit via the safe submit control, falling back to Enter on a text field.
    const t = cfg.budget.interactionTimeoutMs;
    let clicked = false;
    if (form.submit) {
      clicked = await locate(page, form.submit.selector, form.submit.frameUrl)
        .click({ timeout: t, noWaitAfter: true })
        .then(() => true)
        .catch(() => false);
    }
    if (!clicked) {
      const firstText = fields.find((f) => ['text', 'email', 'search'].includes(f.kind));
      if (firstText) {
        await page
          .locator(firstText.selector)
          .first()
          .press('Enter', { timeout: t, noWaitAfter: true })
          .catch(() => {});
      }
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
    result.navigated = normalizeUrl(urlBefore) !== normalizeUrl(page.url());
    if (result.navigated) {
      result.submitted = true;
      return result;
    }
    const invalid = await invalidCount(ctx, form);
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
