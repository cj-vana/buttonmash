/**
 * The run loop. Discovers elements, fingerprints state, runs oracles, chooses
 * and performs a gated action, logs a replayable trace, and captures artifacts
 * when signals appear — until a budget (actions / wall-clock / saturation) is
 * hit or a hard stop (live billing under `refuse`) fires.
 */
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import type { Browser, Page } from 'playwright';

import type { ResolvedConfig } from '../config/load';
import { sleep, TimeoutError, withDeadline } from '../core/async';
import { normalizeUrl, routePath, stateFingerprint } from '../core/hash';
import { logger } from '../core/logger';
import { anyMatch, compileRegexes, combineRegexes } from '../core/regex';
import { Rng } from '../core/rng';
import {
  EXIT,
  SEVERITY_ORDER,
  type LoggedAction,
  type RunResult,
  type Severity,
} from '../core/types';
import {
  captureScreenshot,
  ensureArtifactDir,
  startTracing,
  stopTracing,
} from '../capture/artifacts';
import { aggregateFindings } from '../detectors/aggregate';
import { runPageChecks, type DetectorState } from '../detectors/page-checks';
import { SignalRecorder } from '../detectors/recorder';
import {
  attachSignalListeners,
  DEFAULT_CONSOLE_IGNORE,
  type CustomConsoleRule,
} from '../detectors/signals';
import { DANGEROUS_PATH_RE } from '../guardrails/destructive';
import { attachPageFence, installContextFence, isAllowedOrigin } from '../guardrails/fence';
import { launchBrowser, createDeterministicContext } from '../session/browser';
import { performScriptedLogin, validateStorageState } from '../session/auth';
import { executeAction, gatePlan, planAction, type ActionContext } from './actions';
import { collectLinks, discoverElements, drainNavLog, INTERACTIVE_SELECTOR } from './discover';
import { groupForms } from './forms';
import { Explorer } from './explorer';

import { version } from '../version';

export interface RunButtonmashResult {
  result: RunResult;
  outDir: string;
}

/**
 * Wait for the page to be usable: the 'load' event, then (bounded) for at least
 * one interactive element to exist. Client-rendered SPAs resolve
 * 'domcontentloaded' before they mount, so discovery would otherwise see an
 * empty page.
 */
async function awaitReady(page: Page, ms: number): Promise<void> {
  await withDeadline(page.waitForLoadState('load'), ms, 'load').catch(() => {});
  await page
    .waitForFunction(
      (sel) => {
        if (document.querySelectorAll(sel as string).length > 0) return true;
        // Shadow-DOM apps (Lit/Stencil) and iframe UIs keep every control out
        // of the light DOM — an open shadow root or a frame counts as ready,
        // or this probe would burn the full timeout on every single action.
        if (document.querySelector('iframe')) return true;
        const els = document.querySelectorAll('*');
        const cap = Math.min(els.length, 4000);
        for (let i = 0; i < cap; i++) {
          if ((els[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) return true;
        }
        return false;
      },
      INTERACTIVE_SELECTOR,
      { timeout: ms, polling: 250 },
    )
    .catch(() => {});
}

export async function runButtonmash(cfg: ResolvedConfig): Promise<RunButtonmashResult> {
  logger.setLevel(cfg.logLevel);
  const startedAt = new Date();
  const start = Date.now();
  const outDir = resolve(process.cwd(), cfg.report.outDir);
  await mkdir(outDir, { recursive: true });
  await ensureArtifactDir(outDir);

  logger.banner(`🐒 buttonmash v${version}`);
  logger.info(`Target:  ${cfg.target}`);
  logger.info(`Seed:    ${cfg.seed}   (re-run with --seed ${cfg.seed} to reproduce)`);
  logger.info(
    `Budget:  ${cfg.budget.maxActions} actions / ${Math.round(cfg.budget.maxDurationMs / 1000)}s`,
  );
  if (cfg.guardrails.dryRun) logger.info('Mode:    DRY RUN (read-only)');

  // An invalid/missing auth file falls back to an unauthenticated run — passing
  // the path through anyway would make browser.newContext() throw (exit 2).
  if (cfg.auth.storageState && !(await validateStorageState(cfg.auth.storageState))) {
    cfg = { ...cfg, auth: { ...cfg.auth, storageState: undefined } };
  }

  const rng = new Rng(cfg.seed);
  const recorder = new SignalRecorder();
  const state: DetectorState = { pendingCanaries: new Set(), seenBrokenImages: new Set() };
  const screenshots = new Map<number, string>();
  const actionLog: LoggedAction[] = [];
  const pagesVisited = new Set<string>();

  let billingLive = false;
  const markBillingLive = (reasons: string[]): void => {
    if (!billingLive) {
      billingLive = true;
      logger.warn(`Live billing mode detected: ${reasons.join(', ')}`);
    }
  };

  const ignore = compileRegexes([
    ...cfg.detectors.ignorePatterns,
    ...(cfg.detectors.useDefaultIgnore ? DEFAULT_CONSOLE_IGNORE : []),
  ]);
  const compileCustom = (target: 'console' | 'dom' | 'url'): CustomConsoleRule[] =>
    cfg.detectors.custom
      .filter((c) => c.target === target)
      .flatMap((c) => {
        const re = compileRegexes([c.pattern])[0];
        return re ? [{ name: c.name, re, severity: c.severity }] : [];
      });
  const customConsole = compileCustom('console');
  const customDom = compileCustom('dom');
  const customUrl = compileCustom('url');
  // Hard-block dangerous paths (logout, delete, cancel) at the route level too,
  // not just by control label — unless the user opts into destructive testing.
  const pathRegexes = compileRegexes(cfg.guardrails.blockedPathPatterns);
  if (cfg.guardrails.destructive.enabled && !cfg.guardrails.destructive.allow) {
    pathRegexes.push(DANGEROUS_PATH_RE);
  }
  const blockedPathRe = combineRegexes(pathRegexes);
  const includeRe = compileRegexes(cfg.guardrails.includePaths);
  const excludeRe = compileRegexes(cfg.guardrails.excludePaths);
  const allowedSet = new Set(cfg.guardrails.allowedOrigins);

  const browser: Browser = await launchBrowser(cfg.browser, cfg.headless);
  const handles = await createDeterministicContext(browser, cfg, await ensureArtifactDir(outDir));
  const context = handles.context;
  let page = handles.page; // reassigned if the renderer crashes and we recreate it

  const fenceOpts = {
    allowedOrigins: cfg.guardrails.allowedOrigins,
    blockedPathRe,
    blockMedia: cfg.guardrails.blockMedia,
    billingMode: cfg.guardrails.billing.mode,
    isBillingLatched: () => billingLive,
  };
  // Page-bound wiring, re-attachable to a recreated page after a crash.
  // Playwright does NOT close a crashed page — it stays open and every
  // operation throws "Target crashed" — so recovery keys on this latch,
  // not on page.isClosed().
  let pageCrashed = false;
  const wirePage = (p: typeof page): void => {
    attachSignalListeners({
      page: p,
      recorder,
      cfg,
      ignore,
      customConsole,
      onBillingLive: markBillingLive,
    });
    attachPageFence(p, fenceOpts, recorder);
    p.on('crash', () => {
      pageCrashed = true;
    });
  };
  const setupPage = async (): Promise<typeof page> => {
    const p = await context.newPage(); // inherits context init scripts + routes
    p.setDefaultTimeout(cfg.budget.actionTimeoutMs);
    p.setDefaultNavigationTimeout(Math.max(cfg.budget.actionTimeoutMs, 30_000));
    wirePage(p);
    return p;
  };

  await installContextFence(context, fenceOpts, recorder);
  wirePage(page);
  await startTracing(context, cfg);

  const MAX_CRASHES = 5;
  let crashCount = 0;
  let lastUrl = cfg.target;

  const explorer = new Explorer(rng, cfg.explore.epsilon);
  const navTimeout = Math.max(cfg.budget.actionTimeoutMs, 30_000);

  // Crawl frontier. Configured routes seed it; when crawl is on, every
  // same-origin link discovered while exploring is enqueued too, so one run
  // sweeps the whole reachable site breadth-first. Dangerous/off-origin URLs
  // are never enqueued.
  const FRONTIER_CAP = 5000;
  const visited = new Set<string>(); // normalized URLs already explored
  const queued = new Set<string>(); // normalized URLs currently in the frontier
  const crashedUrls = new Set<string>(); // pages that crashed the renderer — don't revisit
  const frontier: string[] = []; // absolute URLs to visit (FIFO)

  const enqueue = (raw: string): void => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (!allowedSet.has(u.origin)) return;
    // routePath folds hash-router routes in, so `#/account/delete` is guarded
    // exactly like `/account/delete`.
    const p = routePath(u);
    if (blockedPathRe?.test(p)) return;
    if (excludeRe.length && anyMatch(p, excludeRe)) return;
    if (includeRe.length && !anyMatch(p, includeRe)) return;
    const n = normalizeUrl(raw);
    if (visited.has(n) || queued.has(n) || crashedUrls.has(n) || frontier.length >= FRONTIER_CAP)
      return;
    queued.add(n);
    frontier.push(raw);
  };

  for (const s of cfg.routes) enqueue(s);

  const gotoUrl = async (u: string): Promise<void> => {
    await withDeadline(
      page.goto(u, { waitUntil: 'domcontentloaded', timeout: navTimeout }),
      navTimeout + 5_000,
      'goto',
    ).catch((err) => {
      recorder.add('driver', `navigation to ${u} failed: ${(err as Error).message}`, {
        severity: 'low',
        url: u,
      });
    });
  };

  /** Navigate to the next unvisited page in the frontier; false if empty. */
  const gotoNext = async (): Promise<boolean> => {
    while (frontier.length > 0) {
      const u = frontier.shift()!;
      const n = normalizeUrl(u);
      queued.delete(n);
      if (visited.has(n)) continue;
      // Mark the *requested* URL visited, not just wherever we land: a link
      // that redirects elsewhere (or fails to load) would otherwise be
      // re-enqueued and re-attempted forever, and the frontier never drains.
      visited.add(n);
      await gotoUrl(u);
      return true;
    }
    return false;
  };

  // Move to the next page. When the link/nav frontier is dry, return to the
  // target and keep exploring — many SPAs navigate via buttons, so re-clicking
  // around the app surfaces new routes (the explorer remembers what it already
  // tried). Give up only after several returns reveal no new page.
  let emptyReturns = 0;
  let pagesAtLastEmpty = -1;
  const moveOn = async (): Promise<boolean> => {
    if (await gotoNext()) return true;
    if (visited.size === pagesAtLastEmpty) emptyReturns += 1;
    else emptyReturns = 0;
    pagesAtLastEmpty = visited.size;
    if (emptyReturns >= 3) return false;
    await gotoUrl(cfg.target);
    return true;
  };

  if (cfg.explore.crawl) logger.info('Crawl:   auto-discovering links across the site');
  else if (cfg.routes.length) logger.info(`Routes:  sweeping ${1 + cfg.routes.length} routes`);

  // Auth: detect logged-out/login pages and (re-)authenticate via a login script.
  const authConfigured = !!(cfg.auth.storageState || cfg.auth.loginScript);
  const loginRe = new RegExp(cfg.auth.loginUrlPattern, 'i');
  const isLoginPage = (u: string): boolean => {
    try {
      // routePath so a hash-routed `#/login` is recognized too.
      return loginRe.test(routePath(new URL(u)));
    } catch {
      return false;
    }
  };
  let wasAuthenticated = false;
  // Consecutive re-login attempts that never leave the login page mean the
  // script/credentials are broken — retrying up to maxActions times would burn
  // the whole budget against the auth endpoint (and can lock the account).
  let loginAttempts = 0;
  const MAX_LOGIN_ATTEMPTS = 3;
  const doLogin = async (): Promise<void> => {
    if (!cfg.auth.loginScript) return;
    const ls = {
      ...cfg.auth.loginScript,
      url: new URL(cfg.auth.loginScript.url, cfg.target).toString(),
    };
    logger.step('Logging in via login script…');
    await performScriptedLogin(page, ls, navTimeout).catch(() => {});
  };

  // Signals fired during login/initial load (startup console errors, 404s for
  // assets) must carry the target URL, or they dedup-split from the identical
  // signals recorded once the loop sets a real context.
  recorder.setContext(0, cfg.target);

  if (cfg.auth.loginScript) await doLogin();

  // Initial navigation (a hard failure here is critical).
  try {
    await withDeadline(
      page.goto(cfg.target, { waitUntil: 'domcontentloaded', timeout: navTimeout }),
      navTimeout + 5_000,
      'initial-goto',
    );
  } catch (err) {
    recorder.add('driver', `failed to load target: ${(err as Error).message}`, {
      severity: 'critical',
      url: cfg.target,
    });
  }

  const crawlDone = (): string =>
    cfg.explore.crawl ? 'crawl complete — no more pages to visit' : 'all routes swept';

  let depth = 0;
  let sinceNew = 0;
  let recordsCreated = 0;
  let stopReason = 'budget exhausted';
  let internalError = false;

  // Graceful shutdown: on SIGINT/SIGTERM (CI cancel/timeout) flip a flag and let
  // the loop break cleanly so the report still flushes with partial findings.
  let aborted = false;
  const onSignal = (): void => {
    aborted = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    for (let i = 0; i < cfg.budget.maxActions; i++) {
      if (aborted) {
        stopReason = 'aborted (received SIGINT/SIGTERM)';
        break;
      }
      if (Date.now() - start > cfg.budget.maxDurationMs) {
        stopReason = 'time budget reached';
        break;
      }
      if (visited.size >= cfg.budget.maxPages) {
        stopReason = `page budget reached (${cfg.budget.maxPages} pages)`;
        break;
      }
      if (billingLive && cfg.guardrails.billing.mode === 'refuse') {
        stopReason = 'live billing mode detected (refusing to continue)';
        break;
      }
      if (pageCrashed || page.isClosed()) {
        // On a real crash the signal listener already recorded it (with URL
        // context); only an unexpected close needs its own signal.
        if (!pageCrashed) {
          recorder.add('crash', `page closed unexpectedly on ${lastUrl}`, {
            severity: 'critical',
            url: lastUrl,
          });
        }
        pageCrashed = false;
        crashCount += 1;
        if (crashCount > MAX_CRASHES) {
          stopReason = `too many renderer crashes (${crashCount})`;
          break;
        }
        crashedUrls.add(normalizeUrl(lastUrl)); // don't revisit the page that crashed
        await page.close().catch(() => {});
        page = await setupPage();
        depth = 0;
        sinceNew = 0;
        if (!(await moveOn())) await gotoUrl(cfg.target);
        continue;
      }

      // Move to the next page when this one is exhausted (saturated), we've gone
      // too deep, or a click left us off-origin / on a blank or error page. If the
      // frontier is empty, the whole reachable site has been covered.
      let url = page.url();
      const offOrigin = !isAllowedOrigin(url, allowedSet);
      const deadPage = url === 'about:blank' || url === '' || url.startsWith('chrome-error');
      const saturated = sinceNew >= cfg.budget.saturationLimit;
      if (depth >= cfg.budget.maxDepth || offOrigin || deadPage || saturated) {
        if (!(await moveOn())) {
          stopReason = crawlDone();
          break;
        }
        depth = 0;
        sinceNew = 0;
        url = page.url();
      }
      // Session handling: if auth is configured and we land on a login page, log
      // in (or, if we had been authenticated, treat it as a session drop). Gated
      // on authConfigured so genuinely public apps never false-positive.
      if (authConfigured && isLoginPage(url)) {
        if (wasAuthenticated) {
          recorder.add(
            'session-lost',
            `redirected to a login page (${url}) — session likely expired`,
            {
              severity: 'high',
            },
          );
        }
        if (cfg.auth.loginScript) {
          loginAttempts += 1;
          if (loginAttempts > MAX_LOGIN_ATTEMPTS) {
            recorder.add(
              'session-lost',
              `login script failed to authenticate after ${MAX_LOGIN_ATTEMPTS} attempts — check credentials/selectors`,
              { severity: 'high' },
            );
            stopReason = 'login script could not authenticate';
            break;
          }
          await doLogin();
          await gotoUrl(cfg.target);
          depth = 0;
          sinceNew = 0;
          url = page.url();
        } else if (wasAuthenticated) {
          stopReason = 'session expired — set auth.loginScript to re-authenticate';
          break;
        }
      }
      if (authConfigured && !isLoginPage(url)) {
        wasAuthenticated = true;
        loginAttempts = 0;
      }

      const nUrl = normalizeUrl(url);
      lastUrl = url;
      recorder.setContext(i, url);
      pagesVisited.add(nUrl);
      visited.add(nUrl);

      // Wait for the app to actually render interactive content. Client-rendered
      // SPAs return from 'domcontentloaded' before React/Vue has mounted, so we
      // also wait (bounded) for at least one interactive element to appear.
      await awaitReady(page, cfg.budget.readyTimeoutMs);

      // Grow the frontier with same-origin links AND any client-side (SPA)
      // navigations the app made (button/navigate() routes that aren't <a href>).
      if (cfg.explore.crawl) {
        for (const link of await collectLinks(page)) enqueue(link);
        for (const nav of await drainNavLog(page)) enqueue(nav);
      }

      const signalsBefore = recorder.count();
      // Discover and act with the smallest possible gap between them, so the
      // chosen element's selector can't go stale before we classify + execute.
      const elements = await discoverElements(page);
      const stateHash = stateFingerprint(
        url,
        elements.map((e) =>
          cfg.explore.stateGranularity === 'structural' ? e.structuralFp : e.fp,
        ),
      );
      const newState = explorer.isNewState(stateHash);
      explorer.markState(stateHash);
      sinceNew = newState ? 0 : sinceNew + 1;

      if (elements.length === 0) {
        if (!(await moveOn())) {
          stopReason = crawlDone();
          break;
        }
        depth = 0;
        sinceNew = 0;
        continue;
      }

      // Decide: CONSTRUCT (fill+submit a fresh create-surface to populate the app
      // and reach deep editors) or normal explore. Construct only when forms are
      // enabled, a fresh create-surface exists, the global record cap allows, and
      // a seeded coin says so — otherwise fall through to today's behavior.
      const forms = cfg.explore.forms.enabled
        ? groupForms(elements, cfg.explore.forms.createVerbs)
        : [];
      let plan: ReturnType<typeof planAction> | undefined;
      let chosenForm: ReturnType<typeof explorer.chooseForm>;
      if (
        forms.length > 0 &&
        recordsCreated < cfg.explore.forms.maxRecords &&
        rng.bool(cfg.explore.forms.weight)
      ) {
        chosenForm = explorer.chooseForm(forms, cfg.explore.forms.maxAttemptsPerForm);
        if (chosenForm) {
          explorer.recordFormAttempt(chosenForm.fpKey);
          plan = gatePlan({ kind: 'submit-form', form: chosenForm }, cfg, recorder);
        }
      }
      if (!plan) {
        const el = explorer.choose(stateHash, elements);
        plan = gatePlan(planAction(rng, cfg, el), cfg, recorder);
      }
      const ctx: ActionContext = { page, rng, cfg, runId: cfg.seed, step: i, state, recorder };

      let navigated = false;
      try {
        const res = await executeAction(ctx, plan);
        navigated = res.navigated;
        if (res.submitted && chosenForm) {
          recordsCreated += 1;
          explorer.markFormCompleted(chosenForm.fpKey);
          // Follow into the created record: reset so the frontier/oracles re-run.
          depth = 0;
          sinceNew = 0;
        }
        actionLog.push({
          step: i,
          kind: res.kind,
          stateHash,
          fp: res.fp,
          target: res.target,
          selector: res.selector,
          value: res.value,
          url,
          ts: Date.now(),
          navigated: res.navigated,
          formKey: res.formKey,
          fieldsFilled: res.fieldsFilled,
          retries: res.retries,
          submitted: res.submitted,
        });
        logger.debug(
          `#${i} ${res.kind}${res.target ? ` "${res.target}"` : ''}${res.value ? ` = ${res.value}` : ''}`,
        );
      } catch (err) {
        if (err instanceof TimeoutError) {
          recorder.add(
            'hang',
            `${err.message} (action ${plan.kind} on ${plan.el?.selector ?? 'page'})`,
            {
              severity: 'high',
            },
          );
        } else {
          recorder.add('driver', `action ${plan.kind} failed: ${(err as Error).message}`, {
            severity: 'low',
          });
        }
      }

      if (navigated) depth += 1;

      await sleep(cfg.budget.throttleMs);

      // Oracles run AFTER the action, on the resulting state — this keeps the
      // expensive content/axe scans out of the discover→act window.
      if (!page.isClosed()) {
        await runPageChecks(
          {
            page,
            recorder,
            cfg,
            state,
            markBillingLive,
            customDom,
            customUrl,
            timeLeftMs: cfg.budget.maxDurationMs - (Date.now() - start),
          },
          newState,
        );
      }

      // Screenshot the step if it surfaced new signals.
      if (cfg.report.captureScreenshots && recorder.count() > signalsBefore && !page.isClosed()) {
        const shot = await captureScreenshot(page, outDir, i);
        if (shot) screenshots.set(i, shot);
      }
    }
  } catch (err) {
    // An unexpected internal error must not lose the partial report.
    stopReason = `internal error: ${(err as Error).message}`;
    internalError = true;
    recorder.add('driver', `run loop error: ${(err as Error).message}`, { severity: 'medium' });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  logger.step(`Stopping: ${stopReason}.`);

  // Teardown — close context to flush video, stop tracing first.
  const traceRel = await stopTracing(context, cfg, outDir).catch(() => undefined);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const findings = aggregateFindings({
    signals: recorder.signals,
    actions: actionLog,
    screenshots,
  });
  if (traceRel && findings.length) {
    findings[0]!.artifacts.push({ type: 'trace', path: traceRel, mime: 'application/zip' });
  }

  const findingsBySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of findings) findingsBySeverity[f.severity] += 1;

  const failThreshold = SEVERITY_ORDER[cfg.failOn];
  // A run truncated by an internal error must not read as a clean pass (exit 0
  // hid real truncations behind a green build); findings above the threshold
  // still win — "bugs found" carries more information than "tool errored".
  const failed = findings.some((f) => SEVERITY_ORDER[f.severity] >= failThreshold);
  const exitCode = failed ? EXIT.FINDINGS : internalError ? EXIT.ERROR : EXIT.CLEAN;

  // Redacted snapshot of the resolved config for faithful cross-machine replay.
  const resolvedConfig = JSON.parse(JSON.stringify(cfg)) as {
    configPath?: unknown;
    headers?: Record<string, string>;
    auth?: {
      storageState?: string;
      loginScript?: { username?: string; password?: string };
      basicAuth?: { username: string; password: string };
    };
  } & Record<string, unknown>;
  delete resolvedConfig.configPath;
  if (resolvedConfig.auth?.storageState) resolvedConfig.auth.storageState = '<storageState>';
  if (resolvedConfig.auth?.loginScript) {
    resolvedConfig.auth.loginScript.username = '***';
    resolvedConfig.auth.loginScript.password = '***';
  }
  if (resolvedConfig.auth?.basicAuth)
    resolvedConfig.auth.basicAuth = { username: '***', password: '***' };
  if (resolvedConfig.headers) {
    for (const k of Object.keys(resolvedConfig.headers)) resolvedConfig.headers[k] = '***';
  }

  const finishedAt = new Date();
  const result: RunResult = {
    schemaVersion: 1,
    tool: { name: 'buttonmash', version },
    run: {
      id: cfg.seed,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - start,
      target: cfg.target,
      browser: cfg.browser,
      viewport: cfg.viewport,
      exitCode,
      dryRun: cfg.guardrails.dryRun,
    },
    config: {
      seed: cfg.seed,
      maxActions: cfg.budget.maxActions,
      maxDurationMs: cfg.budget.maxDurationMs,
      failOn: cfg.failOn,
    },
    stats: {
      actionsTaken: actionLog.length,
      pagesVisited: pagesVisited.size,
      statesDiscovered: explorer.statesDiscovered,
      recordsCreated,
      findingsBySeverity,
    },
    actions: actionLog,
    findings,
    resolvedConfig,
  };

  return { result, outDir };
}
