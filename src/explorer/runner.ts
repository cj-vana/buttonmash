/**
 * The run loop. Discovers elements, fingerprints state, runs oracles, chooses
 * and performs a gated action, logs a replayable trace, and captures artifacts
 * when signals appear — until a budget (actions / wall-clock / saturation) is
 * hit or a hard stop (live billing under `refuse`) fires.
 */
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import type { Browser } from 'playwright';

import type { ResolvedConfig } from '../config/load';
import { loadBaseline } from '../baseline';
import { sleep, TimeoutError, withDeadline } from '../core/async';
import { normalizeUrl, routePath, stateFingerprint } from '../core/hash';
import { logger } from '../core/logger';
import { compileRegexes, combineRegexes } from '../core/regex';
import { Rng } from '../core/rng';
import type { LoggedAction, RunResult } from '../core/types';
import {
  captureScreenshot,
  ensureArtifactDir,
  startTracing,
  stopTracing,
} from '../capture/artifacts';
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
import { collectLinks, discoverElements, drainNavLog } from './discover';
import { groupForms } from './forms';
import { Explorer } from './explorer';
import { RouteFrontier } from './frontier';
import { awaitPageReady } from './readiness';
import { finalizeRun } from './run-result';

import { version } from '../version';

export interface RunButtonmashResult {
  result: RunResult;
  outDir: string;
}

type TerminationKind =
  | 'complete'
  | 'aborted'
  | 'billing-refused'
  | 'crash-limit'
  | 'auth-failed'
  | 'session-expired'
  | 'internal-error';

interface Termination {
  kind: TerminationKind;
  reason: string;
}

export async function runButtonmash(cfg: ResolvedConfig): Promise<RunButtonmashResult> {
  logger.setLevel(cfg.logLevel);
  const startedAt = new Date();
  const start = Date.now();
  // Validate the baseline before launching a browser or spending the run budget.
  const baselineSnapshot = cfg.baseline.path ? await loadBaseline(cfg.baseline.path) : undefined;
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

  // Configured routes seed a bounded breadth-first frontier; crawl discovery
  // adds same-origin links and client-side navigations as the run progresses.
  const frontier = new RouteFrontier({
    allowedOrigins: allowedSet,
    blockedPath: blockedPathRe,
    includePaths: includeRe,
    excludePaths: excludeRe,
  });
  for (const route of cfg.routes) frontier.enqueue(route);

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

  const moveOn = (): Promise<boolean> => frontier.moveOn(cfg.target, gotoUrl);

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
  let initialLoadFailed = false;
  try {
    await withDeadline(
      page.goto(cfg.target, { waitUntil: 'domcontentloaded', timeout: navTimeout }),
      navTimeout + 5_000,
      'initial-goto',
    );
  } catch (err) {
    initialLoadFailed = true;
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
  let termination: Termination = { kind: 'complete', reason: 'budget exhausted' };

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
        termination = { kind: 'aborted', reason: 'aborted (received SIGINT/SIGTERM)' };
        break;
      }
      if (Date.now() - start > cfg.budget.maxDurationMs) {
        termination = { kind: 'complete', reason: 'time budget reached' };
        break;
      }
      if (frontier.visitedCount >= cfg.budget.maxPages) {
        termination = {
          kind: 'complete',
          reason: `page budget reached (${cfg.budget.maxPages} pages)`,
        };
        break;
      }
      if (billingLive && cfg.guardrails.billing.mode === 'refuse') {
        termination = {
          kind: 'billing-refused',
          reason: 'live billing mode detected (refusing to continue)',
        };
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
          termination = {
            kind: 'crash-limit',
            reason: `too many renderer crashes (${crashCount})`,
          };
          break;
        }
        frontier.markCrashed(lastUrl); // don't revisit the page that crashed
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
          termination = { kind: 'complete', reason: crawlDone() };
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
            termination = { kind: 'auth-failed', reason: 'login script could not authenticate' };
            break;
          }
          await doLogin();
          await gotoUrl(cfg.target);
          depth = 0;
          sinceNew = 0;
          url = page.url();
        } else if (wasAuthenticated) {
          termination = {
            kind: 'session-expired',
            reason: 'session expired — set auth.loginScript to re-authenticate',
          };
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
      frontier.markVisited(nUrl);

      // Wait for the app to actually render interactive content. Client-rendered
      // SPAs return from 'domcontentloaded' before React/Vue has mounted, so we
      // also wait (bounded) for at least one interactive element to appear.
      await awaitPageReady(page, cfg.budget.readyTimeoutMs);

      // Grow the frontier with same-origin links AND any client-side (SPA)
      // navigations the app made (button/navigate() routes that aren't <a href>).
      if (cfg.explore.crawl) {
        for (const link of await collectLinks(page)) frontier.enqueue(link);
        for (const nav of await drainNavLog(page)) frontier.enqueue(nav);
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
          termination = { kind: 'complete', reason: crawlDone() };
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
    termination = { kind: 'internal-error', reason: `internal error: ${(err as Error).message}` };
    recorder.add('driver', `run loop error: ${(err as Error).message}`, { severity: 'medium' });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  logger.step(`Stopping: ${termination.reason}.`);

  // Teardown — close context to flush video, stop tracing first.
  const traceRel = await stopTracing(context, cfg, outDir).catch(() => undefined);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const result = finalizeRun({
    cfg,
    baseline: baselineSnapshot,
    startedAt,
    startTimeMs: start,
    signals: recorder.signals,
    actions: actionLog,
    screenshots,
    tracePath: traceRel,
    pagesVisited: pagesVisited.size,
    statesDiscovered: explorer.statesDiscovered,
    recordsCreated,
    completion: {
      complete: termination.kind === 'complete' && !initialLoadFailed && !aborted,
      internalError: termination.kind === 'internal-error',
    },
  });

  return { result, outDir };
}
