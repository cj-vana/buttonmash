/**
 * A forced Playwright action skips the check that the target receives the
 * pointer, so it lands on whatever is drawn at the target's centre: the
 * "Delete all" button of a dialog lying over a checkbox, for example. Forced
 * actions that click go through {@link assertUncovered} first.
 */
import type { Locator } from 'playwright';

export class CoveredControlError extends Error {
  constructor(what: string) {
    super(`${what} is covered by another element`);
    this.name = 'CoveredControlError';
  }
}

/**
 * Throw unless the point a forced click would hit is the control itself or one
 * of its own labels. Custom checkboxes pass: the real input is hidden and its
 * label is drawn on top, and a click on the label toggles the input.
 */
export async function assertUncovered(loc: Locator, what: string, timeout: number): Promise<void> {
  const clear = await loc.evaluate(
    (el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const root = el.getRootNode() as Document | ShadowRoot;
      const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit) return false;
      if (hit === el || el.contains(hit)) return true;
      const labels = (el as HTMLInputElement).labels;
      return !!labels && Array.from(labels).some((l) => l === hit || l.contains(hit));
    },
    undefined,
    { timeout },
  );
  if (!clear) throw new CoveredControlError(what);
}
