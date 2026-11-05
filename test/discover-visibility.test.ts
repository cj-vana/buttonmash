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

describe('discovery in iframes', () => {
  // Each check is one Playwright's click makes too: a control in one of these
  // frames passes every test in its own document, and the click times out.
  it('skips controls in an iframe the page hides', async () => {
    expect(
      await namesOn(
        '<iframe style="visibility:hidden" srcdoc="<button>Hidden frame</button>"></iframe>' +
          '<iframe srcdoc="<button>Shown frame</button>"></iframe>',
      ),
    ).toEqual(['Shown frame']);
  });

  it('skips controls in an inert iframe and under an inert ancestor', async () => {
    expect(
      await namesOn(
        '<iframe inert srcdoc="<button>Inert frame</button>"></iframe>' +
          '<div inert><iframe srcdoc="<button>Inert parent</button>"></iframe></div>' +
          '<button>Awake</button>',
      ),
    ).toEqual(['Awake']);
  });

  it('skips a frame nested in a hidden frame', async () => {
    expect(
      await namesOn(
        `<iframe style="visibility:hidden" srcdoc="<iframe srcdoc='<button>Nested</button>'></iframe>"></iframe>` +
          '<button>Outside</button>',
      ),
    ).toEqual(['Outside']);
  });

  it('keeps only the frames inside an open modal dialog', async () => {
    expect(
      await namesOn(
        '<iframe srcdoc="<button>Behind the dialog</button>"></iframe>' +
          '<dialog id="d"><iframe srcdoc="<button>In the dialog</button>"></iframe></dialog>',
        (page) =>
          page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).showModal()),
      ),
    ).toEqual(['In the dialog']);
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
