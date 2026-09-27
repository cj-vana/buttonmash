/**
 * Real-browser checks that an action lands on the control the guardrails
 * classified, and nothing else: implicit form submission, covered controls,
 * nth-child selectors that drift while a form is filled, and same-URL iframes.
 */
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

import { loadConfig } from '../src/config/load';
import { Rng } from '../src/core/rng';
import { SignalRecorder } from '../src/detectors/recorder';
import { classifyControl } from '../src/guardrails/destructive';
import {
  executeAction,
  gatePlan,
  implicitSubmitRisk,
  type ActionContext,
} from '../src/explorer/actions';
import { discoverElements, locate } from '../src/explorer/discover';
import { fillAndSubmit } from '../src/explorer/form-runner';
import { groupForms } from '../src/explorer/forms';
import { CoveredControlError } from '../src/explorer/hit-test';

const LOG = '<script>window.__log = []; window.log = (m) => window.__log.push(m);</script>';

const PAGES: Record<string, string> = {
  '/enter-delete':
    '<form action="/api/delete-account" method="post">' +
    '<input id="reason" placeholder="Reason (optional)"><button>Delete account</button></form>',
  '/enter-search':
    '<form action="/search"><input id="q" placeholder="Search"><button>Search</button></form>',
  '/enter-login':
    '<form action="/session" method="post"><input id="user" placeholder="Email">' +
    '<input type="password" id="pw"><button>Continue</button></form>',
  '/covered-checkbox':
    '<table><tr><td><input type="checkbox" id="row" aria-label="Select row"></td></tr></table>' +
    '<div role="dialog" style="position:fixed;inset:0;z-index:10;background:#fff">' +
    '<button style="width:100%;height:100%" onclick="log(\'DELETED ALL\')">Delete all invoices</button></div>',
  '/custom-checkbox':
    '<label><input type="checkbox" id="terms" style="position:absolute;width:1px;height:1px;' +
    'overflow:hidden;clip:rect(0 0 0 0)"><span style="display:inline-block;width:20px;height:20px;' +
    'border:1px solid">.</span> Accept terms</label>',
  '/default-button':
    '<form onsubmit="event.preventDefault(); log(\'submitted via \' + event.submitter.textContent)">' +
    '<input name="title" placeholder="Title" required>' +
    '<button name="op" value="delete">Delete</button><button name="op" value="save">Save</button></form>' +
    '<div style="position:fixed;inset:0;z-index:10;background:#eee">cookie banner</div>',
  '/stale-submit':
    '<form onsubmit="event.preventDefault(); log(\'submitted via \' + event.submitter.textContent)">' +
    '<input name="title" placeholder="Title" required oninput="markDirty()">' +
    '<div id="footer"><button type="button" onclick="log(\'DELETED\')">Delete project</button>' +
    '<button type="submit">Save</button></div></form>' +
    "<script>function markDirty(){if(document.getElementById('dirty'))return;" +
    "const s=document.createElement('span');s.id='dirty';s.textContent='Unsaved changes';" +
    "document.getElementById('footer').prepend(s);}</script>",
  '/frames': '<iframe name="a" src="/widget"></iframe><iframe name="b" src="/widget"></iframe>',
  '/widget':
    "<script>const b=document.createElement('button');" +
    "b.textContent=name==='a'?'Delete workspace':'Rename workspace';" +
    'b.onclick=()=>parent.log(b.textContent);' +
    "addEventListener('DOMContentLoaded',()=>document.body.append(b));</script>",
  '/text-input': '<input id="title" placeholder="Title"><input id="qty" type="number">',
  '/formaction':
    '<form action="/save" method="post"><input name="n">' +
    '<button formaction="/account/delete" aria-label="x">x</button></form>',
  '/autosave':
    '<form><input name="title" placeholder="Title" required ' +
    'onchange="log(\'autosaved\')"><button>Create</button></form>',
  '/shadow-form':
    '<x-form></x-form><script>customElements.define("x-form",class extends HTMLElement{' +
    'connectedCallback(){const r=this.attachShadow({mode:"open"});' +
    'r.innerHTML=\'<form><input name="title" placeholder="Title" required><button>Create</button></form>\';' +
    'const f=r.querySelector("form");f.addEventListener("submit",(e)=>{e.preventDefault();' +
    'r.querySelector("input").setAttribute("aria-invalid","true");log("rejected");});}});</script>',
};

let server: Server;
let base: string;
let browser: Browser;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (req.method !== 'GET') hits.push(`${req.method} ${path}`);
    const body = PAGES[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ? `<!doctype html><meta charset="utf-8">${LOG}<body>${body}</body>` : 'no');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function open(path: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(base + path, { waitUntil: 'load' });
  return page;
}

async function context(
  page: Page,
  overrides: Record<string, unknown> = {},
  rng: Rng = new Rng('safety'),
): Promise<ActionContext> {
  const cfg = await loadConfig({
    ignoreConfigFile: true,
    overrides: { target: base, budget: { interactionTimeoutMs: 800 }, ...overrides },
  });
  return {
    page,
    rng,
    cfg,
    runId: 'safety',
    step: 1,
    state: { pendingCanaries: new Set(), seenBrokenImages: new Set() },
    recorder: new SignalRecorder(),
  };
}

const pageLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __log: string[] }).__log);

async function element(page: Page, name: string) {
  const found = (await discoverElements(page)).find((e) => e.name === name);
  if (!found) throw new Error(`no element named ${name}`);
  return found;
}

describe('Enter in a form field', () => {
  it('is refused when it would submit through a destructive or auth form', async () => {
    for (const [path, field] of [
      ['/enter-delete', '#reason'],
      ['/enter-login', '#user'],
    ] as const) {
      const page = await open(path);
      const ctx = await context(page);
      expect(await implicitSubmitRisk(ctx, page.locator(field))).not.toBeNull();
      await page.close();
    }
  });

  it('is allowed in an ordinary form', async () => {
    const page = await open('/enter-search');
    const ctx = await context(page);
    expect(await implicitSubmitRisk(ctx, page.locator('#q'))).toBeNull();
    await page.close();
  });

  it('is never pressed by the key action when it would submit the form', async () => {
    const page = await open('/enter-delete');
    const alwaysEnter = { pick: () => 'Enter' } as unknown as Rng;
    const ctx = await context(page, {}, alwaysEnter);
    const el = await element(page, 'Reason (optional)');
    const before = hits.length;
    const result = await executeAction(ctx, { kind: 'key', el });
    await page.waitForTimeout(300);
    expect(hits.slice(before)).toEqual([]);
    expect(result.value).toContain('skipped');
    await page.close();
  });
});

describe('checking a checkbox', () => {
  it('refuses when another element covers it, instead of clicking that element', async () => {
    const page = await open('/covered-checkbox');
    const ctx = await context(page);
    const el = await element(page, 'Select row');
    await expect(executeAction(ctx, { kind: 'check', el })).rejects.toBeInstanceOf(
      CoveredControlError,
    );
    expect(await pageLog(page)).toEqual([]);
    await page.close();
  });

  it('still works on a custom checkbox drawn by its label', async () => {
    const page = await open('/custom-checkbox');
    const ctx = await context(page, {}, { bool: () => true } as unknown as Rng);
    const el = (await discoverElements(page)).find((e) => e.selector === '#terms')!;
    await executeAction(ctx, { kind: 'check', el });
    expect(await page.locator('#terms').isChecked()).toBe(true);
    await page.close();
  });
});

describe('form completion', () => {
  it('never submits through the default button when the classified submit is covered', async () => {
    const page = await open('/default-button');
    const ctx = await context(page);
    const [form] = groupForms(await discoverElements(page));
    expect(form?.submit?.name).toBe('Save');
    await fillAndSubmit(ctx, form!);
    expect(await pageLog(page)).not.toContain('submitted via Delete');
    await page.close();
  });

  it('clicks the submit it classified even after filling shifts the DOM', async () => {
    const page = await open('/stale-submit');
    const ctx = await context(page);
    const [form] = groupForms(await discoverElements(page));
    expect(form?.submit?.name).toBe('Save');
    await fillAndSubmit(ctx, form!);
    const log = await pageLog(page);
    expect(log).not.toContain('DELETED');
    expect(log).toContain('submitted via Save');
    await page.close();
  });

  it('fills nothing in dry run, so change handlers never fire', async () => {
    const page = await open('/autosave');
    const ctx = await context(page, { guardrails: { dryRun: true } });
    const [form] = groupForms(await discoverElements(page));
    expect(gatePlan({ kind: 'submit-form', form }, ctx.cfg, ctx.recorder).kind).not.toBe(
      'submit-form',
    );
    const result = await fillAndSubmit(ctx, form!);
    expect(result.fieldsFilled).toBe(0);
    expect(await page.locator('input').inputValue()).toBe('');
    await page.close();
  });

  it('reads validation inside a shadow root, so a rejected form is not counted as created', async () => {
    const page = await open('/shadow-form');
    await page.waitForTimeout(200);
    const ctx = await context(page);
    const [form] = groupForms(await discoverElements(page));
    const result = await fillAndSubmit(ctx, form!);
    expect(await pageLog(page)).toContain('rejected');
    expect(result.submitted).toBe(false);
    await page.close();
  });
});

describe('discovery identity', () => {
  it('acts in the right frame when two iframes share a URL', async () => {
    const page = await open('/frames');
    await page.waitForTimeout(300);
    const rename = await element(page, 'Rename workspace');
    await locate(page, rename.selector, rename.frameUrl, rename.frameIndex).click();
    expect(await pageLog(page)).toEqual(['Rename workspace']);
    await page.close();
  });

  it('keeps a text field fingerprint when its value changes', async () => {
    const page = await open('/text-input');
    const before = await element(page, 'Title');
    await page.fill('#title', 'something typed');
    const after = (await discoverElements(page)).find((e) => e.selector === before.selector);
    expect(after?.fp).toBe(before.fp);
    await page.close();
  });

  it("classifies a button by its own formaction, which overrides the form's", async () => {
    const page = await open('/formaction');
    const button = await element(page, 'x');
    expect(button.formAction).toBe('/account/delete');
    expect(classifyControl(button).block).toBe(true);
    await page.close();
  });
});

describe('typing', () => {
  it('types numbers into number inputs without driver errors', async () => {
    const page = await open('/text-input');
    const qty = (await discoverElements(page)).find((e) => e.type === 'number')!;
    for (let step = 0; step < 12; step++) {
      const ctx = { ...(await context(page, {}, new Rng(`n${step}`))), step };
      await executeAction(ctx, { kind: 'type', el: qty });
    }
    await page.close();
  });

  it('types plain text when fuzzInputs is off', async () => {
    const page = await open('/text-input');
    const ctx = await context(page, { explore: { fuzzInputs: false } });
    const result = await executeAction(ctx, { kind: 'type', el: await element(page, 'Title') });
    expect(result.value).toMatch(/^[a-z0-9 ]+$/i);
    await page.close();
  });
});
