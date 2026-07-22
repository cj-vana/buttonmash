import type { Page } from 'playwright';

import { withDeadline } from '../core/async';
import { INTERACTIVE_SELECTOR } from './discover';

/**
 * Wait for the page to be usable: the load event, then (bounded) for at least
 * one interactive element. Open shadow roots and iframes also count as ready.
 */
export async function awaitPageReady(page: Page, timeoutMs: number): Promise<void> {
  await withDeadline(page.waitForLoadState('load'), timeoutMs, 'load').catch(() => {});
  await page
    .waitForFunction(
      (selector) => {
        if (document.querySelectorAll(selector as string).length > 0) return true;
        if (document.querySelector('iframe')) return true;
        const elements = document.querySelectorAll('*');
        const limit = Math.min(elements.length, 4000);
        for (let index = 0; index < limit; index++) {
          if ((elements[index] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
            return true;
          }
        }
        return false;
      },
      INTERACTIVE_SELECTOR,
      { timeout: timeoutMs, polling: 250 },
    )
    .catch(() => {});
}
