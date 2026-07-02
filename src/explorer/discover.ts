/**
 * Interactive-element discovery. Unlike gremlins.js (which picks random screen
 * coordinates and misses anything below the fold or occluded), we enumerate
 * elements via a broad selector covering native + ARIA + tabindex +
 * contenteditable controls, filter to actionable ones, and build a stable
 * fingerprint and a locator for each.
 */
import type { Locator, Page } from 'playwright';

import { withDeadline } from '../core/async';
import { elementFingerprint, structuralFingerprint } from '../core/hash';
import type { ElementDescriptor } from '../core/types';

export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=switch]',
  '[role=option]',
  '[role=combobox]',
  '[role=slider]',
  '[role=textbox]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[onclick]',
  'summary',
  'label[for]',
].join(',');

type RawDescriptor = Omit<ElementDescriptor, 'fp' | 'structuralFp'>;

/** Runs in the browser (per document/frame); returns serializable descriptors
 *  for visible controls, piercing OPEN shadow roots. Shadow-DOM elements are
 *  tagged with an ephemeral [data-bm-id] so Playwright (whose CSS engine pierces
 *  open shadow roots) can relocate them; light-DOM elements keep an nth-child path. */
function collect(arg: { selector: string; framePrefix: string }): RawDescriptor[] {
  const { selector, framePrefix } = arg;
  const isVisible = (e: Element): boolean => {
    const el = e as HTMLElement;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none' &&
      el.getAttribute('aria-hidden') !== 'true'
    );
  };

  const structuralPath = (e: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = e;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      const parent: Element | null = cur.parentElement;
      const idx = parent ? Array.prototype.indexOf.call(parent.children, cur) : 0;
      parts.unshift(cur.tagName.toLowerCase() + ':' + idx);
      cur = parent;
    }
    return parts.join('>');
  };

  const cssSelector = (e: Element): string => {
    const id = (e as HTMLElement).id;
    if (id && /^[A-Za-z][\w-]*$/.test(id) && document.querySelectorAll('#' + (window as any).CSS.escape(id)).length === 1) {
      return '#' + (window as any).CSS.escape(id);
    }
    const parts: string[] = [];
    let cur: Element | null = e;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const parent: Element | null = cur.parentElement;
      if (!parent) break;
      const idx = Array.prototype.indexOf.call(parent.children, cur) + 1;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
      cur = parent;
    }
    return parts.length ? parts.join(' > ') : e.tagName.toLowerCase();
  };

  const accessibleName = (e: Element): string => {
    const el = e as HTMLElement & { value?: string };
    const candidates = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.textContent,
      typeof el.value === 'string' ? el.value : '',
      el.getAttribute('placeholder'),
      el.getAttribute('name'),
    ];
    for (const c of candidates) {
      const t = (c || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 80);
    }
    return '';
  };

  const labelFor = (e: Element): string => {
    const el = e as HTMLElement & { labels?: NodeListOf<HTMLLabelElement>; id?: string };
    const al = el.getAttribute('aria-label');
    if (al) return al.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (t) return t.slice(0, 80);
    }
    if (el.labels && el.labels.length) {
      const t = (el.labels[0]?.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 80);
    }
    const wrap = el.closest('label');
    if (wrap?.textContent) return wrap.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
    return '';
  };

  const scopeKey = (e: Element): string => {
    const form = (e as HTMLInputElement).form;
    const scope =
      form ||
      e.closest('[role="dialog"],dialog,[aria-modal="true"],.modal,.drawer,.wizard,form,fieldset');
    return scope ? structuralPath(scope) : 'page';
  };

  const numAttr = (el: HTMLElement, prop: 'minLength' | 'maxLength'): number | undefined => {
    const v = (el as unknown as Record<string, number>)[prop];
    return typeof v === 'number' && v >= 0 ? v : undefined;
  };

  const out: RawDescriptor[] = [];
  const seen = new Set<Element>();
  // Monotonic across discovery passes (persisted on window): restarting at 0
  // would re-issue tags that *hidden* elements still carry from earlier passes,
  // so two elements could match the same [data-bm-id] and actions could land
  // on the wrong one.
  const w = window as unknown as { __bmSeq?: number };
  let bm = w.__bmSeq ?? 0;

  const handle = (e: Element, inShadow: boolean): void => {
    if (seen.has(e) || !isVisible(e)) return;
    seen.add(e);
    const el = e as HTMLElement & {
      form?: HTMLFormElement;
      type?: string;
      disabled?: boolean;
      required?: boolean;
      options?: HTMLOptionsCollection;
    };
    const tag = el.tagName.toLowerCase();
    const type = typeof el.type === 'string' ? el.type : null;
    const isSubmit =
      (tag === 'input' && type === 'submit') ||
      (tag === 'button' && (!el.getAttribute('type') || el.getAttribute('type') === 'submit') && !!el.form);
    const isFormField =
      tag === 'select' ||
      tag === 'textarea' ||
      el.isContentEditable ||
      el.getAttribute('role') === 'textbox' ||
      (tag === 'input' && !['submit', 'button', 'reset', 'image', 'hidden'].includes(type ?? 'text'));

    // nth-child paths can't cross a shadow boundary; tag shadow elements instead.
    let selectorStr: string;
    if (inShadow) {
      const id = `${framePrefix}s${bm++}`;
      try {
        el.setAttribute('data-bm-id', id);
      } catch {
        /* read-only */
      }
      selectorStr = `[data-bm-id="${id}"]`;
    } else {
      selectorStr = cssSelector(el);
    }

    out.push({
      tag,
      type,
      role: el.getAttribute('role'),
      name: accessibleName(el),
      editable: el.isContentEditable,
      path: structuralPath(el),
      selector: selectorStr,
      href: el.getAttribute('href') || undefined,
      formAction: el.form?.getAttribute('action') || el.getAttribute('formaction') || undefined,
      formMethod: (el.form?.getAttribute('method') || el.getAttribute('formmethod') || '').toUpperCase() || undefined,
      disabled: el.disabled === true,
      formKey: scopeKey(el),
      isSubmit,
      ...(isFormField
        ? {
            required: el.required === true || el.getAttribute('aria-required') === 'true',
            pattern: el.getAttribute('pattern') || undefined,
            min: el.getAttribute('min') || undefined,
            max: el.getAttribute('max') || undefined,
            step: el.getAttribute('step') || undefined,
            minLength: numAttr(el, 'minLength'),
            maxLength: numAttr(el, 'maxLength'),
            autocomplete: el.getAttribute('autocomplete') || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            label: labelFor(el),
            options:
              tag === 'select' && el.options
                ? Array.from(el.options).map((o) => ({
                    value: o.value,
                    label: (o.textContent || '').trim().slice(0, 60),
                    disabled: o.disabled,
                  }))
                : undefined,
          }
        : {}),
    });
  };

  // Walk light DOM + all OPEN shadow roots, in stable document order.
  const visit = (root: Document | ShadowRoot, inShadow: boolean): void => {
    let els: Element[];
    try {
      els = Array.prototype.slice.call(root.querySelectorAll('*'));
    } catch {
      return;
    }
    for (const el of els) {
      try {
        if ((el as Element).matches(selector)) handle(el, inShadow);
      } catch {
        /* invalid for matches */
      }
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) visit(sr, true);
    }
  };
  visit(document, false);
  w.__bmSeq = bm;
  return out;
}

/**
 * Collect every same-origin link target on the page (resolved to absolute
 * URLs), including framework `<Link>`s which render as `<a href>`. This is what
 * powers auto-crawl: the URLs feed a frontier the explorer works through.
 */
export async function collectLinks(page: Page): Promise<string[]> {
  try {
    return await withDeadline(
      page.evaluate(() => {
        const urls = new Set<string>();
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const href = (a as HTMLAnchorElement).href; // already absolute
          if (href) urls.add(href);
        }
        return Array.from(urls);
      }),
      5_000,
      'collect-links',
    );
  } catch {
    return [];
  }
}

/**
 * Drain the in-page log of client-side (SPA) navigations recorded since the
 * last call. Lets the crawler discover routes reached via buttons/`navigate()`,
 * which never appear as `<a href>` links.
 */
export async function drainNavLog(page: Page): Promise<string[]> {
  try {
    return await withDeadline(
      page.evaluate(() => {
        const w = window as unknown as { __bmNav?: string[] };
        const arr = Array.isArray(w.__bmNav) ? w.__bmNav.slice() : [];
        w.__bmNav = [];
        return arr;
      }),
      4_000,
      'drain-nav',
    );
  } catch {
    return [];
  }
}

function frameOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
}

const MAX_FRAMES = 8;

export async function discoverElements(page: Page): Promise<ElementDescriptor[]> {
  const collected: { raws: RawDescriptor[]; frameUrl?: string }[] = [];

  // Main frame.
  try {
    const raws = await withDeadline(
      page.evaluate(collect, { selector: INTERACTIVE_SELECTOR, framePrefix: '' }),
      8_000,
      'discover',
    );
    collected.push({ raws });
  } catch {
    /* nothing from main frame this step */
  }

  // Same-origin child frames (embedded editors/forms/dashboards). Stable order.
  const mainOrigin = frameOrigin(page.url());
  const frames = page
    .frames()
    .filter((f) => f !== page.mainFrame() && frameOrigin(f.url()) !== '' && frameOrigin(f.url()) === mainOrigin)
    .sort((a, b) => (a.url() + a.name()).localeCompare(b.url() + b.name()))
    .slice(0, MAX_FRAMES);
  let fi = 0;
  for (const f of frames) {
    fi += 1;
    try {
      const raws = await withDeadline(
        f.evaluate(collect, { selector: INTERACTIVE_SELECTOR, framePrefix: `f${fi}` }),
        5_000,
        'discover-frame',
      );
      collected.push({ raws, frameUrl: f.url() });
    } catch {
      /* frame detached or cross-origin race */
    }
  }

  const out: ElementDescriptor[] = [];
  for (const { raws, frameUrl } of collected) {
    for (const r of raws) {
      if (r.disabled) continue;
      out.push({ ...r, frameUrl, fp: elementFingerprint(r), structuralFp: structuralFingerprint(r) });
    }
  }
  return out;
}

/** Resolve a Locator for an element, in its owning frame if any. Playwright's
 *  CSS engine pierces open shadow roots, so [data-bm-id] selectors resolve there. */
export function locate(page: Page, selector: string, frameUrl?: string): Locator {
  if (frameUrl) {
    const f = page.frames().find((fr) => fr.url() === frameUrl);
    if (f) return f.locator(selector).first();
  }
  return page.locator(selector).first();
}
