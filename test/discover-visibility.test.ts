/**
 * Discovery must offer only controls a user could reach: not the contents of a
 * closed <details>, not an inert subtree, and not the page behind an open
 * modal dialog. Picking those produced low driver-error findings on real apps,
 * each a click that timed out or landed on the dialog instead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';

import { discoverElements } from '../src/explorer/discover';

// Chromium by default; CI's cross-browser jobs set BUTTONMASH_SMOKE_BROWSER.
const engine = { chromium, firefox, webkit }[
  process.env.BUTTONMASH_SMOKE_BROWSER === 'firefox' ||
  process.env.BUTTONMASH_SMOKE_BROWSER === 'webkit'
    ? process.env.BUTTONMASH_SMOKE_BROWSER
    : 'chromium'
];

let browser: Browser;

beforeAll(async () => {
  browser = await engine.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function namesOn(html: string, prepare?: (page: Page) => Promise<void>): Promise<string[]> {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><body>${html}</body>`);
    await prepare?.(page);
    return (await discoverElements(page)).map((e) => e.name).sort();
  } finally {
    await page.close();
  }
}

describe('discovery visibility', () => {
  it('skips controls inside a closed <details>, and finds them once it opens', async () => {
    const html =
      '<details id="more"><summary>More</summary><button>Inside</button></details>' +
      '<button>Outside</button>';
    expect(await namesOn(html)).toEqual(['More', 'Outside']);
    expect(
      await namesOn(html, (page) =>
        page.evaluate(() => {
          (document.getElementById('more') as HTMLDetailsElement).open = true;
        }),
      ),
    ).toEqual(['Inside', 'More', 'Outside']);
  });

  it('skips controls inside an inert subtree', async () => {
    expect(await namesOn('<div inert><button>Asleep</button></div><button>Awake</button>')).toEqual(
      ['Awake'],
    );
  });
});

describe('discovery under a modal dialog', () => {
  it('offers only the controls of an open aria-modal dialog', async () => {
    expect(
      await namesOn(
        '<button>Background</button>' +
          '<div role="dialog" aria-modal="true"><button>Confirm</button></div>',
      ),
    ).toEqual(['Confirm']);
  });

  it('ignores an aria-modal dialog that is not shown', async () => {
    expect(
      await namesOn(
        '<button>Background</button>' +
          '<div role="dialog" aria-modal="true" style="display:none"><button>Confirm</button></div>',
      ),
    ).toEqual(['Background']);
  });

  it('offers only the controls of a native modal <dialog>', async () => {
    expect(
      await namesOn(
        '<button>Background</button><dialog id="d"><button>Inside dialog</button></dialog>',
        (page) =>
          page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).showModal()),
      ),
    ).toEqual(['Inside dialog']);
  });

  it('offers only the top dialog when modals are stacked', async () => {
    expect(
      await namesOn(
        '<button>Background</button>' +
          '<div role="dialog" aria-modal="true"><button>Edit</button></div>' +
          '<div role="dialog" aria-modal="true"><button>Discard changes?</button></div>',
      ),
    ).toEqual(['Discard changes?']);
  });

  it('reaches a modal dialog rendered inside an open shadow root', async () => {
    expect(
      await namesOn('<button>Background</button><x-dialog></x-dialog>', (page) =>
        page.evaluate(() => {
          customElements.define(
            'x-dialog',
            class extends HTMLElement {
              connectedCallback() {
                const root = this.attachShadow({ mode: 'open' });
                const dialog = document.createElement('div');
                dialog.setAttribute('role', 'dialog');
                dialog.setAttribute('aria-modal', 'true');
                const button = document.createElement('button');
                button.textContent = 'Shadow confirm';
                dialog.append(button);
                root.append(dialog);
              }
            },
          );
        }),
      ),
    ).toEqual(['Shadow confirm']);
  });
});
