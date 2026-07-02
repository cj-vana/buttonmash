#!/usr/bin/env node
/** buttonmash command-line interface. */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import { loadConfig, ConfigError, type LoadOptions } from './config/load';
import type { Config } from './config/schema';
import { logger } from './core/logger';
import { EXIT, SEVERITY_ORDER, type RunResult } from './core/types';
import { runButtonmash } from './explorer/runner';
import { writeReports } from './report';
import { captureAuth } from './session/auth';
import type { Engine } from './session/browser';
import { version } from './version';

const program = new Command();

program
  .name('buttonmash')
  .description('A CI chaos monkey for web apps — press every button, mash keys, break things, report.')
  .version(version, '-v, --version');

interface RunOpts {
  config?: string;
  seed?: string;
  browser?: Engine;
  headed?: boolean;
  maxActions?: string;
  maxDuration?: string;
  failOn?: string;
  dryRun?: boolean;
  auth?: string;
  out?: string;
  formats?: string;
  screenshots?: boolean;
  allowOrigin?: string[];
  billing?: 'refuse' | 'warn' | 'off';
  logLevel?: string;
  route?: string[];
}

function buildOverrides(url: string | undefined, o: RunOpts): Partial<Config> {
  const ov: Partial<Config> = {};
  if (url) ov.target = url;
  if (o.seed) ov.seed = o.seed;
  if (o.browser) ov.browser = o.browser;
  if (o.headed) ov.headless = false;
  if (o.failOn) ov.failOn = o.failOn as Config['failOn'];
  if (o.logLevel) ov.logLevel = o.logLevel as Config['logLevel'];

  const budget: NonNullable<Config['budget']> = {};
  if (o.maxActions) budget.maxActions = Number(o.maxActions);
  if (o.maxDuration) budget.maxDurationMs = Number(o.maxDuration) * 1000;
  if (Object.keys(budget).length) ov.budget = budget;

  if (o.auth) ov.auth = { storageState: o.auth };

  const report: NonNullable<Config['report']> = {};
  if (o.out) report.outDir = o.out;
  if (o.formats) {
    report.formats = o.formats.split(',').map((s) => s.trim()) as NonNullable<
      Config['report']
    >['formats'];
  }
  if (o.screenshots === false) report.captureScreenshots = false;
  if (Object.keys(report).length) ov.report = report;

  const guardrails: NonNullable<Config['guardrails']> = {};
  if (o.dryRun) guardrails.dryRun = true;
  if (o.billing) guardrails.billing = { mode: o.billing };
  if (Object.keys(guardrails).length) ov.guardrails = guardrails;

  return ov;
}

function printSummary(result: RunResult, outDir: string, htmlReport: boolean): void {
  const f = result.stats.findingsBySeverity;
  console.log('');
  console.log(
    result.run.exitCode === EXIT.CLEAN
      ? pc.green(pc.bold('✓ PASSED')) + pc.dim(' — nothing broke above the fail threshold')
      : result.run.exitCode === EXIT.ERROR
        ? pc.yellow(pc.bold('⚠ ERROR')) + pc.dim(' — the run was truncated by an internal error (partial results)')
        : pc.red(pc.bold('✗ FAILED')) + pc.dim(` — findings ≥ ${result.config.failOn}`),
  );
  console.log(
    `  ${result.stats.actionsTaken} actions · ${result.stats.pagesVisited} pages · ${result.stats.statesDiscovered} states · ${(result.run.durationMs / 1000).toFixed(1)}s`,
  );
  const parts = (['critical', 'high', 'medium', 'low', 'info'] as const)
    .filter((s) => f[s] > 0)
    .map((s) => `${f[s]} ${s}`);
  console.log(`  ${result.findings.length} findings${parts.length ? ': ' + parts.join(' · ') : ''}`);
  if (htmlReport) console.log(pc.dim(`  Report: ${resolve(outDir, 'report.html')}`));
  console.log(pc.dim(`  Reproduce: buttonmash run ${result.run.target} --seed ${result.config.seed}`));
}

async function doRun(url: string | undefined, opts: RunOpts, loadOpts: LoadOptions = {}): Promise<never> {
  try {
    if (opts.failOn && !(opts.failOn in SEVERITY_ORDER)) {
      throw new ConfigError(`--fail-on must be one of: ${Object.keys(SEVERITY_ORDER).join(', ')}`);
    }
    const cfg = await loadConfig({
      configPath: opts.config,
      overrides: buildOverrides(url, opts),
      // --route/--allow-origin are documented as *additional* — append to the
      // config file's lists rather than replacing them.
      append: { routes: opts.route, allowedOrigins: opts.allowOrigin },
      ...loadOpts,
    });
    const { result, outDir } = await runButtonmash(cfg);
    await writeReports(result, outDir, cfg);
    printSummary(result, outDir, cfg.report.formats.includes('html'));
    process.exit(result.run.exitCode);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (err instanceof ConfigError) {
      logger.error(message);
    } else if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) {
      logger.error('The browser is not installed.');
      logger.info(`Run:  npx playwright install --with-deps ${opts.browser ?? 'chromium'}`);
    } else {
      logger.error(`buttonmash crashed: ${(err as Error).stack ?? message}`);
    }
    process.exit(EXIT.ERROR);
  }
}

program
  .command('run', { isDefault: true })
  .description('Run the chaos monkey against a target URL')
  .argument('[url]', 'target URL (overrides config `target`)')
  .option('-c, --config <path>', 'path to a buttonmash config file')
  .option('-s, --seed <seed>', 'reproducibility seed')
  .option('--route <url...>', 'additional route(s) to sweep in the same run (one run covers them all)')
  .option('-b, --browser <engine>', 'chromium | firefox | webkit')
  .option('--headed', 'run with a visible browser window')
  .option('--max-actions <n>', 'maximum actions to perform')
  .option('--max-duration <seconds>', 'maximum wall-clock seconds')
  .option('--fail-on <severity>', 'min severity that fails the build (critical|high|medium|low|info)')
  .option('--dry-run', 'read-only mode: explore without submitting or mutating')
  .option('--auth <path>', 'Playwright storageState JSON for an authenticated session')
  .option('-o, --out <dir>', 'output directory for reports/artifacts')
  .option('--formats <list>', 'comma-separated: json,junit,html,sarif')
  .option('--no-screenshots', 'do not capture screenshots')
  .option('--allow-origin <origin...>', 'additional allowed origin(s)')
  .option('--billing <mode>', 'live-billing guard: refuse | warn | off')
  .option('--log-level <level>', 'silent|error|warn|info|debug')
  .action((url: string | undefined, opts: RunOpts) => doRun(url, opts));

program
  .command('replay <seedOrResults> [url]')
  .description('Re-run with a previous seed (or a results.json) to reproduce a finding')
  .option('-c, --config <path>', 'path to a buttonmash config file')
  .option('-b, --browser <engine>', 'chromium | firefox | webkit')
  .option('--headed', 'run with a visible browser window')
  .option('-o, --out <dir>', 'output directory for reports/artifacts')
  .action((seedOrResults: string, url: string | undefined, opts: RunOpts) => {
    let seed = seedOrResults;
    let target = url;
    if (seedOrResults.endsWith('.json') && !existsSync(seedOrResults)) {
      // A mistyped path must not silently become a fuzz run seeded with it.
      logger.error(`Results file not found: ${seedOrResults}`);
      process.exit(EXIT.ERROR);
    }
    if (seedOrResults.endsWith('.json') && existsSync(seedOrResults)) {
      try {
        const prev = JSON.parse(readFileSync(seedOrResults, 'utf8')) as RunResult;
        seed = prev.config.seed;
        target = target ?? prev.run.target;
        logger.info(`Replaying seed ${seed} against ${target}`);
      } catch (err) {
        logger.error(`Could not read results file: ${(err as Error).message}`);
        process.exit(EXIT.ERROR);
      }
    }
    return doRun(target, { ...opts, seed });
  });

program
  .command('auth <url>')
  .description('Open a browser, log in by hand, and save the session for runs')
  .option('-o, --out <path>', 'where to save storageState', 'playwright/.auth/user.json')
  .option('-b, --browser <engine>', 'chromium | firefox | webkit', 'chromium')
  .action(async (url: string, opts: { out: string; browser: Engine }) => {
    try {
      await captureAuth(url, opts.out, opts.browser);
      process.exit(EXIT.CLEAN);
    } catch (err) {
      logger.error(`auth failed: ${(err as Error).message}`);
      process.exit(EXIT.ERROR);
    }
  });

program
  .command('init')
  .description('Write a starter buttonmash.config.ts')
  .option('-f, --force', 'overwrite an existing config')
  .action((opts: { force?: boolean }) => {
    const path = resolve(process.cwd(), 'buttonmash.config.ts');
    if (existsSync(path) && !opts.force) {
      logger.error('buttonmash.config.ts already exists (use --force to overwrite).');
      process.exit(EXIT.ERROR);
    }
    writeFileSync(path, STARTER_CONFIG, 'utf8');
    logger.success(`Wrote ${path}`);
    logger.info('Next: capture auth with `buttonmash auth <login-url>`, then `buttonmash run`.');
    process.exit(EXIT.CLEAN);
  });

const STARTER_CONFIG = `import { defineConfig } from 'buttonmash';

export default defineConfig({
  // The app to hammer. Use a staging/test environment, never production.
  target: 'http://localhost:3000',

  // Pin a seed in CI so failures are reproducible.
  seed: 'ci',

  // An authenticated session captured with: buttonmash auth <login-url>
  auth: { storageState: 'playwright/.auth/user.json' },

  budget: { maxActions: 500, maxDurationMs: 300_000, maxPages: 100 },

  // Auto-crawl is on by default — buttonmash sweeps the whole reachable site.
  // 'routes' are optional hints for pages nothing links to (e.g. a deep editor).
  // routes: ['/dashboard'],

  guardrails: {
    // Stay on these origins (defaults to the target's origin).
    // allowedOrigins: ['https://staging.example.com'],
    // Refuse to run if LIVE Stripe/Braintree keys are detected. Use test mode!
    billing: { mode: 'refuse' },
    // dryRun: true, // read-only: explore without submitting/mutating
  },

  detectors: {
    // a11y: true, // opt-in axe-core accessibility scan
    ignoreHttpStatuses: [401, 403], // expected on some probes
    ignorePatterns: [], // regex strings for benign console/network noise
  },

  // Minimum severity that fails the build.
  failOn: 'high',
});
`;

program.parseAsync(process.argv).catch((err) => {
  logger.error((err as Error).message);
  process.exit(EXIT.ERROR);
});
