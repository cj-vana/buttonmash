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
import { sleep, TimeoutError, withDeadline } from '../core/async';
import { normalizeUrl, stateFingerprint } from '../core/hash';
import { logger } from '../core/logger';
import { compileRegexes, combineRegexes } from '../core/regex';
import { Rng } from '../core/rng';
import {
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
import { attachSignalListeners, type CustomConsoleRule } from '../detectors/signals';
import { DANGEROUS_PATH_RE } from '../guardrails/destructive';
import { installFence } from '../guardrails/fence';
import { launchBrowser, createDeterministicContext } from '../session/browser';
import { validateStorageState } from '../session/auth';
import { executeAction, gatePlan, planAction, type ActionContext } from './actions';
import { discoverElements } from './discover';
import { Explorer } from './explorer';

import { version } from '../version';

export interface RunButtonmashResult {
  result: RunResult;
  outDir: string;
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
  logger.info(`Budget:  ${cfg.budget.maxActions} actions / ${Math.round(cfg.budget.maxDurationMs / 1000)}s`);
  if (cfg.guardrails.dryRun) logger.info('Mode:    DRY RUN (read-only)');

  if (cfg.auth.storageState) await validateStorageState(cfg.auth.storageState);

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

  const ignore = compileRegexes(cfg.detectors.ignorePatterns);
  const customConsole: CustomConsoleRule[] = cfg.detectors.custom
    .filter((c) => c.target === 'console')
    .flatMap((c) => {
      const re = compileRegexes([c.pattern])[0];
      return re ? [{ name: c.name, re, severity: c.severity }] : [];
    });
  // Hard-block dangerous paths (logout, delete, cancel) at the route level too,
  // not just by control label — unless the user opts into destructive testing.
  const pathRegexes = compileRegexes(cfg.guardrails.blockedPathPatterns);
  if (cfg.guardrails.destructive.enabled && !cfg.guardrails.destructive.allow) {
    pathRegexes.push(DANGEROUS_PATH_RE);
  }
  const blockedPathRe = combineRegexes(pathRegexes);

  const browser: Browser = await launchBrowser(cfg.browser, cfg.headless);
  const { context, page } = await createDeterministicContext(browser, cfg, await ensureArtifactDir(outDir));

  attachSignalListeners({ page, recorder, cfg, ignore, customConsole, onBillingLive: markBillingLive });
  await installFence(
    context,
    page,
    {
      allowedOrigins: cfg.guardrails.allowedOrigins,
      blockedPathRe,
      blockMedia: cfg.guardrails.blockMedia,
      billingMode: cfg.guardrails.billing.mode,
      isBillingLatched: () => billingLive,
    },
    recorder,
  );
  await startTracing(context, cfg);

  const explorer = new Explorer(rng, cfg.explore.epsilon);
  const navTimeout = Math.max(cfg.budget.actionTimeoutMs, 30_000);

  const gotoStart = async (): Promise<void> => {
    await withDeadline(
      page.goto(cfg.target, { waitUntil: 'domcontentloaded', timeout: navTimeout }),
      navTimeout + 5_000,
      'goto',
    ).catch((err) => {
      recorder.add('driver', `navigation to target failed: ${(err as Error).message}`, {
        severity: 'low',
        url: cfg.target,
      });
    });
  };

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

  let depth = 0;
  let sinceNew = 0;
  let stopReason = 'budget exhausted';

  for (let i = 0; i < cfg.budget.maxActions; i++) {
    if (Date.now() - start > cfg.budget.maxDurationMs) {
      stopReason = 'time budget reached';
      break;
    }
    if (sinceNew >= cfg.budget.saturationLimit) {
      stopReason = `state saturated (${sinceNew} actions without new state)`;
      break;
    }
    if (billingLive && cfg.guardrails.billing.mode === 'refuse') {
      stopReason = 'live billing mode detected (refusing to continue)';
      break;
    }
    if (page.isClosed()) {
      stopReason = 'page closed (crash)';
      break;
    }

    const url = page.url();
    recorder.setContext(i, url);
    pagesVisited.add(normalizeUrl(url));

    // Reset to start when too deep or at a dead end (bounded so it can't hang).
    if (depth >= cfg.budget.maxDepth) {
      await gotoStart();
      depth = 0;
    }

    // Brief settle so async content lands before we fingerprint the state.
    await withDeadline(page.waitForLoadState('domcontentloaded'), 3_000, 'settle').catch(() => {});

    const signalsBefore = recorder.count();
    // Discover and act with the smallest possible gap between them, so the
    // chosen element's selector can't go stale before we classify + execute.
    const elements = await discoverElements(page);
    const stateHash = stateFingerprint(
      url,
      elements.map((e) => e.fp),
    );
    const newState = explorer.isNewState(stateHash);
    explorer.markState(stateHash);
    sinceNew = newState ? 0 : sinceNew + 1;

    if (elements.length === 0) {
      await gotoStart();
      depth = 0;
      continue;
    }

    const el = explorer.choose(stateHash, elements);
    const plan = gatePlan(planAction(rng, cfg, el), cfg, recorder);
    const ctx: ActionContext = { page, rng, cfg, runId: cfg.seed, step: i, state, recorder };

    let navigated = false;
    try {
      const res = await executeAction(ctx, plan);
      navigated = res.navigated;
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
      });
      logger.debug(`#${i} ${res.kind}${res.target ? ` "${res.target}"` : ''}${res.value ? ` = ${res.value}` : ''}`);
    } catch (err) {
      if (err instanceof TimeoutError) {
        recorder.add('hang', `${err.message} (action ${plan.kind} on ${plan.el?.selector ?? 'page'})`, {
          severity: 'high',
        });
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
      await runPageChecks({ page, recorder, cfg, state, markBillingLive }, newState);
    }

    // Screenshot the step if it surfaced new signals.
    if (cfg.report.captureScreenshots && recorder.count() > signalsBefore && !page.isClosed()) {
      const shot = await captureScreenshot(page, outDir, i);
      if (shot) screenshots.set(i, shot);
    }
  }

  logger.step(`Stopping: ${stopReason}.`);

  // Teardown — close context to flush video, stop tracing first.
  const traceRel = await stopTracing(context, cfg, outDir).catch(() => undefined);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  const findings = aggregateFindings({ signals: recorder.signals, actions: actionLog, screenshots });
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
  const exitCode = findings.some((f) => SEVERITY_ORDER[f.severity] >= failThreshold) ? 1 : 0;

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
      findingsBySeverity,
    },
    actions: actionLog,
    findings,
  };

  return { result, outDir };
}
