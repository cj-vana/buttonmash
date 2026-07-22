/** Bounded preflight checks for the environment a full run will use. */
import type { Browser, BrowserContext } from 'playwright';

import { BaselineError, baselineComparisonKey, loadBaseline } from './baseline';
import type { ResolvedConfig } from './config/load';
import { routePath } from './core/hash';
import { combineRegexes, compileRegexes } from './core/regex';
import { SignalRecorder } from './detectors/recorder';
import { inspectRequestForLiveMode, scanTextForLiveMode } from './guardrails/billing';
import { DANGEROUS_PATH_RE } from './guardrails/destructive';
import { attachPageFence, installContextFence, isAllowedOrigin } from './guardrails/fence';
import { performScriptedLogin, validateStorageState } from './session/auth';
import { createDeterministicContext, launchBrowser } from './session/browser';
import { version } from './version';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: 'baseline' | 'auth-file' | 'browser' | 'context' | 'target' | 'origin' | 'auth' | 'billing';
  status: DoctorStatus;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

function check(
  checks: DoctorCheck[],
  id: DoctorCheck['id'],
  status: DoctorStatus,
  detail: string,
): void {
  checks.push({ id, status, detail });
}

function isLoginUrl(url: string, pattern: string): boolean {
  const regex = compileRegexes([pattern])[0];
  if (!regex) return false;
  try {
    return regex.test(routePath(new URL(url)));
  } catch {
    return false;
  }
}

/** Run bounded checks without entering the mutation/exploration loop. */
export async function runDoctor(cfg: ResolvedConfig): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  if (cfg.baseline.path) {
    try {
      const baseline = await loadBaseline(cfg.baseline.path);
      const currentKey = baselineComparisonKey(cfg);
      const comparable =
        baseline.complete &&
        baseline.toolVersion === version &&
        currentKey !== undefined &&
        baseline.comparisonKey === currentKey;
      check(
        checks,
        'baseline',
        comparable ? 'pass' : 'warn',
        comparable
          ? `baseline is readable and comparable (${baseline.source})`
          : `baseline is readable but not comparable for resolution (${baseline.source}); check tool version, completion, config, and baseline identity`,
      );
    } catch (err) {
      const detail = err instanceof BaselineError ? err.message : (err as Error).message;
      check(checks, 'baseline', 'fail', detail);
    }
  }

  let storageState = cfg.auth.storageState;
  if (storageState) {
    if (await validateStorageState(storageState)) {
      check(checks, 'auth-file', 'pass', `storage state is valid (${storageState})`);
    } else {
      check(checks, 'auth-file', 'fail', `storage state is missing or invalid (${storageState})`);
      storageState = undefined;
    }
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await launchBrowser(cfg.browser, true);
    check(checks, 'browser', 'pass', `${cfg.browser} launched successfully`);
  } catch (err) {
    check(checks, 'browser', 'fail', `${cfg.browser} could not launch: ${(err as Error).message}`);
    return { ok: false, checks };
  }

  try {
    const handles = await createDeterministicContext(browser, {
      ...cfg,
      headless: true,
      auth: { ...cfg.auth, storageState },
      report: { ...cfg.report, captureVideo: false },
    });
    context = handles.context;
    const { page } = handles;
    const recorder = new SignalRecorder();
    const liveReasons = new Set<string>();
    let billingLatched = false;
    if (cfg.guardrails.billing.mode !== 'off') {
      page.on('request', (request) => {
        for (const reason of inspectRequestForLiveMode(request.url(), request.postData())) {
          liveReasons.add(reason);
          billingLatched = true;
        }
      });
    }
    const pathRegexes = compileRegexes(cfg.guardrails.blockedPathPatterns);
    if (cfg.guardrails.destructive.enabled && !cfg.guardrails.destructive.allow) {
      pathRegexes.push(DANGEROUS_PATH_RE);
    }
    const fenceOptions = {
      allowedOrigins: cfg.guardrails.allowedOrigins,
      blockedPathRe: combineRegexes(pathRegexes),
      blockMedia: cfg.guardrails.blockMedia,
      billingMode: cfg.guardrails.billing.mode,
      isBillingLatched: () => billingLatched,
    };
    await installContextFence(context, fenceOptions, recorder);
    attachPageFence(page, fenceOptions, recorder);

    let scriptOk = true;
    if (cfg.auth.loginScript) {
      const login = {
        ...cfg.auth.loginScript,
        url: new URL(cfg.auth.loginScript.url, cfg.target).toString(),
      };
      if (new URL(login.url).origin !== new URL(cfg.target).origin) {
        scriptOk = false;
        check(checks, 'auth', 'fail', `login script URL must be same-origin (${login.url})`);
      } else {
        scriptOk = await performScriptedLogin(page, login, cfg.budget.actionTimeoutMs);
      }
      if (!scriptOk && !checks.some((item) => item.id === 'auth' && item.status === 'fail')) {
        check(checks, 'auth', 'fail', 'login script could not interact with the configured form');
      }
    }

    let targetOk = false;
    try {
      const response = await page.goto(cfg.target, {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(cfg.budget.actionTimeoutMs, 30_000),
      });
      const status = response?.status();
      if (status && status >= 400) {
        check(checks, 'target', 'fail', `${cfg.target} returned HTTP ${status}`);
      } else {
        targetOk = true;
        check(checks, 'target', 'pass', `${cfg.target} loaded${status ? ` (HTTP ${status})` : ''}`);
      }
    } catch (err) {
      check(checks, 'target', 'fail', `target navigation failed: ${(err as Error).message}`);
    }

    const finalUrl = page.url();
    const allowed = new Set(cfg.guardrails.allowedOrigins);
    check(
      checks,
      'origin',
      isAllowedOrigin(finalUrl, allowed) ? 'pass' : 'fail',
      isAllowedOrigin(finalUrl, allowed)
        ? `final URL stayed within the allowed origins (${finalUrl})`
        : `final URL escaped the allowed origins (${finalUrl})`,
    );

    const authConfigured = Boolean(storageState || cfg.auth.basicAuth || cfg.auth.loginScript);
    if (!authConfigured) {
      check(checks, 'auth', 'pass', 'no authentication configured (public target)');
    } else if (!targetOk) {
      check(checks, 'auth', 'fail', 'authenticated target did not return a successful response');
    } else if (isLoginUrl(finalUrl, cfg.auth.loginUrlPattern)) {
      check(checks, 'auth', 'fail', `authentication ended on a login URL (${finalUrl})`);
    } else if (scriptOk && !checks.some((item) => item.id === 'auth' && item.status === 'fail')) {
      check(checks, 'auth', 'pass', `authenticated target is reachable (${finalUrl})`);
    }

    if (cfg.guardrails.billing.mode === 'off') {
      check(checks, 'billing', 'pass', 'billing detection is disabled by configuration');
    } else {
      try {
        for (const reason of scanTextForLiveMode(await page.content())) liveReasons.add(reason);
      } catch {
        // A failed target check already explains why content could not be read.
      }
    }
    if (cfg.guardrails.billing.mode !== 'off' && liveReasons.size === 0) {
      check(checks, 'billing', 'pass', 'no live billing evidence detected');
    } else if (cfg.guardrails.billing.mode !== 'off') {
      const status: DoctorStatus = cfg.guardrails.billing.mode === 'refuse' ? 'fail' : 'warn';
      check(checks, 'billing', status, `live billing evidence: ${[...liveReasons].join(', ')}`);
    }
  } catch (err) {
    check(checks, 'context', 'fail', `preflight context failed: ${(err as Error).message}`);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  return { ok: !checks.some((item) => item.status === 'fail'), checks };
}
