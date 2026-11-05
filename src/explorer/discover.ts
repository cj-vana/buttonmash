/**
 * Interactive-element discovery. Unlike gremlins.js (which picks random screen
 * coordinates and misses anything below the fold or occluded), we enumerate
 * elements via a broad selector covering native + ARIA + tabindex +
 * contenteditable controls, filter to actionable ones, and build a stable
 * fingerprint and a locator for each.
 */
import type { ElementHandle, Frame, Locator, Page } from 'playwright';

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

interface Collected {
  items: RawDescriptor[];
  /** For each element in `frames`, whether a user could reach the iframe. */
  frames: boolean[];
}

/** Runs in the browser (per document/frame); returns serializable descriptors
 *  for visible controls, piercing OPEN shadow roots. Shadow-DOM elements are
 *  tagged with an ephemeral [data-bm-id] so Playwright (whose CSS engine pierces
 *  open shadow roots) can relocate them; light-DOM elements keep an nth-child path.
 *  `frames` are this document's <iframe> elements: a control inside one is out
 *  of reach when the iframe is hidden, inert, or behind a modal, however it
 *  looks from its own document. */
function collect(arg: { selector: string; framePrefix: string; frames: Element[] }): Collected {
  const { selector, framePrefix } = arg;

  /** Parent in the flat tree: across a shadow root to its host. */
  const composedParent = (n: Element): Element | null =>
    n.parentElement ?? (n.getRootNode() as ShadowRoot).host ?? null;

  const isInert = (e: Element): boolean => {
    for (let n: Element | null = e; n; n = composedParent(n)) {
      if (n.hasAttribute('inert')) return true;
    }
    return false;
  };

  const isVisible = (e: Element): boolean => {
    const el = e as HTMLElement;
    // checkVisibility sees what the box check below misses: the contents of a
    // closed <details> (and any content-visibility: hidden subtree) keep a
    // layout box but are never rendered. Opacity is left unchecked on purpose:
    // a custom checkbox is an opacity-0 input under its label.
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none' &&
      el.getAttribute('aria-hidden') !== 'true' &&
      !isInert(el)
    );
  };

  // An open modal dialog makes the rest of the page unreachable, so only the
  // top one's controls are offered. A native modal (showModal) sits in the top
  // layer above any aria-modal overlay; among several of a kind, the last found
  // stands in for the most recently opened.
  const nativeModals: Element[] = [];
  const ariaModals: Element[] = [];
  const findModals = (root: Document | ShadowRoot): void => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      let nativeModal = false;
      try {
        nativeModal = el.tagName === 'DIALOG' && el.matches(':modal');
      } catch {
        /* :modal unsupported in this engine */
      }
      if (nativeModal && isVisible(el)) nativeModals.push(el);
      else if (el.getAttribute('aria-modal') === 'true' && isVisible(el)) ariaModals.push(el);
      if (el.shadowRoot) findModals(el.shadowRoot);
    }
  };
  findModals(document);
  const modal = nativeModals.at(-1) ?? ariaModals.at(-1) ?? null;
  const reachable = (e: Element): boolean => {
    if (!modal) return true;
    for (let n: Element | null = e; n; n = composedParent(n)) if (n === modal) return true;
    return false;
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
    if (
      id &&
      /^[A-Za-z][\w-]*$/.test(id) &&
      document.querySelectorAll('#' + (window as any).CSS.escape(id)).length === 1
    ) {
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
    const el = e as HTMLElement & { value?: string; type?: string };
    // A value names a button-like input ("Save"); for anything else it is
    // user data, and naming by it would change the fingerprint on every keystroke.
    const valueNames =
      el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type ?? '');
    const candidates = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.textContent,
      valueNames && typeof el.value === 'string' ? el.value : '',
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
    if (seen.has(e) || !isVisible(e) || !reachable(e)) return;
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
      (tag === 'button' &&
        (!el.getAttribute('type') || el.getAttribute('type') === 'submit') &&
        !!el.form);
    const isFormField =
      tag === 'select' ||
      tag === 'textarea' ||
      el.isContentEditable ||
      el.getAttribute('role') === 'textbox' ||
      (tag === 'input' &&
        !['submit', 'button', 'reset', 'image', 'hidden'].includes(type ?? 'text'));

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
      // A submitter's formaction/formmethod override the form's own.
      formAction: el.getAttribute('formaction') || el.form?.getAttribute('action') || undefined,
      formMethod:
        (el.getAttribute('formmethod') || el.form?.getAttribute('method') || '').toUpperCase() ||
        undefined,
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
  return { items: out, frames: arg.frames.map((f) => isVisible(f) && reachable(f)) };
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

function frameDepth(frame: Frame): number {
  let depth = 0;
  for (let parent = frame.parentFrame(); parent; parent = parent.parentFrame()) depth += 1;
  return depth;
}

export async function discoverElements(page: Page): Promise<ElementDescriptor[]> {
  const main = page.mainFrame();
  // Same-origin child frames (embedded editors/forms/dashboards). Stable order.
  const mainOrigin = frameOrigin(page.url());
  const frames = page
    .frames()
    .filter((f) => f !== main && frameOrigin(f.url()) !== '' && frameOrigin(f.url()) === mainOrigin)
    .sort((a, b) => (a.url() + a.name()).localeCompare(b.url() + b.name()))
    .slice(0, MAX_FRAMES);
  const prefixes = new Map(frames.map((f, i) => [f, `f${i + 1}`]));

  // A frame is read only once the document holding its <iframe> has said a
  // user can reach it, so parents go first. A frame under an unreachable one
  // is unreachable too. One whose parent is never read (another origin's
  // frame) keeps being offered.
  const collected = new Map<Frame, RawDescriptor[]>();
  const unreachable = new Set<Frame>();
  for (const f of [main, ...[...frames].sort((a, b) => frameDepth(a) - frameDepth(b))]) {
    const parent = f.parentFrame();
    if (unreachable.has(f) || (parent && unreachable.has(parent))) {
      unreachable.add(f);
      continue;
    }
    const children = (
      await Promise.all(
        frames
          .filter((c) => c.parentFrame() === f)
          .map(async (c) => ({ frame: c, handle: await c.frameElement().catch(() => null) })),
      )
    ).flatMap(({ frame, handle }) => (handle ? [{ frame, handle }] : []));
    try {
      const result = await withDeadline(
        f.evaluate(collect, {
          selector: INTERACTIVE_SELECTOR,
          framePrefix: prefixes.get(f) ?? '',
          frames: children.map((c) => c.handle) as ElementHandle<Element>[],
        }),
        f === main ? 8_000 : 5_000,
        f === main ? 'discover' : 'discover-frame',
      );
      collected.set(f, result.items);
      result.frames.forEach((reachable, i) => {
        const child = children[i]?.frame;
        if (!reachable && child) unreachable.add(child);
      });
    } catch {
      /* frame detached, or the renderer is busy this step */
    } finally {
      for (const { handle } of children) void handle.dispose().catch(() => {});
    }
  }

  const out: ElementDescriptor[] = [];
  for (const f of [main, ...frames]) {
    const frameUrl = f === main ? undefined : f.url();
    const frameIndex = f === main ? 0 : sameUrlIndex(page, f);
    for (const r of collected.get(f) ?? []) {
      if (r.disabled) continue;
      out.push({
        ...r,
        frameUrl,
        ...(frameIndex ? { frameIndex } : {}),
        fp: elementFingerprint(r),
        structuralFp: structuralFingerprint(r),
      });
    }
  }
  return out;
}

/** Resolve a Locator for an element, in its owning frame if any. Playwright's
 *  CSS engine pierces open shadow roots, so [data-bm-id] selectors resolve there. */
export function locate(page: Page, selector: string, frameUrl?: string, frameIndex = 0): Locator {
  if (frameUrl) {
    // Two iframes can load the same URL; the index tells them apart.
    const f = page.frames().filter((fr) => fr.url() === frameUrl)[frameIndex];
    if (f) return f.locator(selector).first();
  }
  return page.locator(selector).first();
}

/** Position of `frame` among the page's frames that share its URL. */
function sameUrlIndex(page: Page, frame: Frame): number {
  return page
    .frames()
    .filter((fr) => fr.url() === frame.url())
    .indexOf(frame);
}
