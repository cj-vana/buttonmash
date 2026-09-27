import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli-program';
import { loadConfig, type ResolvedConfig } from '../src/config/load';
import type { Config } from '../src/config/schema';
import { EXIT, type RunResult } from '../src/core/types';
import { finalizeRun } from '../src/explorer/run-result';
import { startServer, type TestServer } from './helpers/server';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'dist', 'cli.js');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const temporaryDirectories: string[] = [];

beforeAll(() => {
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function run(args: string[], cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('CLI contract', () => {
  it('exposes the documented commands and baseline options', () => {
    const program = createProgram();
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['run', 'doctor', 'replay', 'auth', 'init']),
    );
    const runCommand = program.commands.find((command) => command.name() === 'run');
    expect(runCommand?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--baseline', '--baseline-id', '--fail-on-new']),
    );
  });

  it('prints help from the built package entry point', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('doctor');
    expect(result.stdout).toContain('replay');
  });

  it('exits 2 for command-line usage errors, which exit 1 would report as findings', () => {
    for (const args of [
      ['run', 'https://x.test', '--bogus'],
      ['run', 'https://x.test', '--max-actions'],
      ['replay'],
      ['doctor', 'https://x.test', '--bogus'],
    ]) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr, args.join(' ')).toMatch(/^error: /m);
    }
  });

  it('keeps exit 0 for --help and --version', () => {
    for (const args of [['--help'], ['--version'], ['run', '--help']]) {
      expect(run(args).status, args.join(' ')).toBe(0);
    }
  });

  it('uses exit code 2 for invalid usage before launching a browser', () => {
    const result = run(['run', 'https://example.test', '--fail-on', 'apocalyptic']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--fail-on must be one of');
  });

  it('exits 2 and names the field for an invalid regex in the config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-cli-'));
    temporaryDirectories.push(directory);
    const config = join(directory, 'bad-regex.json');
    writeFileSync(config, JSON.stringify({ guardrails: { blockedPathPatterns: ['delete ('] } }));

    for (const command of ['run', 'doctor']) {
      const result = run([command, 'https://example.test', '--config', config]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('guardrails.blockedPathPatterns.0');
    }
  });

  it('rejects an unknown auth --browser before creating or launching anything', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-cli-'));
    temporaryDirectories.push(directory);

    const result = run(['auth', 'https://x.test/login', '--browser', 'opera'], directory);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--browser must be one of: chromium, firefox, webkit');
    expect(result.stderr).not.toContain('Cannot read properties');
    expect(existsSync(join(directory, 'playwright'))).toBe(false);
  });

  it('scaffolds config and refuses to overwrite it without --force', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-cli-'));
    temporaryDirectories.push(directory);

    const first = run(['init'], directory);
    expect(first.status).toBe(0);
    expect(existsSync(join(directory, 'buttonmash.config.ts'))).toBe(true);

    const second = run(['init'], directory);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain('already exists');
  });

  it('scaffolds a config that loads without an auth file that does not exist yet', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-cli-'));
    temporaryDirectories.push(directory);
    expect(run(['init'], directory).status).toBe(0);

    const cfg = await loadConfig({ cwd: directory });
    expect(cfg.auth.storageState).toBeUndefined();
    const scaffold = readFileSync(join(directory, 'buttonmash.config.ts'), 'utf8');
    expect(scaffold).toContain('buttonmash auth <login-url>');
    expect(scaffold).toMatch(
      /^\s*\/\/ auth: \{ storageState: 'playwright\/\.auth\/user\.json' \},$/m,
    );
  });
});

/** Like `run`, but without blocking this process: the test server lives here. */
function runAsync(args: string[], cwd = root) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (status) => resolve({ status, stdout, stderr })),
  );
}

/** A results.json for `overrides`, finalized and redacted the way a run writes it. */
async function writeResults(directory: string, overrides: Config): Promise<string> {
  const cfg = await loadConfig({ ignoreConfigFile: true, overrides });
  const result = finalizeRun({
    cfg,
    startedAt: new Date(),
    startTimeMs: Date.now(),
    signals: [],
    actions: [],
    screenshots: new Map(),
    pagesVisited: 1,
    statesDiscovered: 1,
    recordsCreated: 0,
    completion: { complete: true, incompleteExitCode: EXIT.FINDINGS },
  });
  const path = join(directory, 'results.json');
  writeFileSync(path, JSON.stringify(result));
  return path;
}

describe('doctor baseline check', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('takes the run flags that decide whether a baseline is comparable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-doctor-'));
    temporaryDirectories.push(directory);
    const baseline = await writeResults(directory, {
      target: server.url,
      seed: 'ci',
      routes: ['/app'],
      budget: { maxActions: 50, maxDurationMs: 90_000 },
      guardrails: { dryRun: true },
      failOn: 'medium',
    });
    const runFlags = [
      '--seed',
      'ci',
      '--route',
      '/app',
      '--max-actions',
      '50',
      '--max-duration',
      '90',
      '--dry-run',
      '--fail-on',
      'medium',
    ];

    const same = await runAsync(
      ['doctor', server.url, '--baseline', baseline, ...runFlags],
      directory,
    );
    expect(same.stderr).not.toContain('unknown option');
    expect(same.stdout).toContain('baseline: baseline is readable and comparable');
    expect(same.status).toBe(0);

    const differs = await runAsync(['doctor', server.url, '--baseline', baseline], directory);
    expect(differs.stdout).toContain('pass doctor the same flags you pass to run');
  }, 60_000);
});

describe('replay', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('rebuilds a dry run from results.json, with flags beating the recorded config', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-replay-'));
    temporaryDirectories.push(directory);
    const results = await writeResults(directory, {
      target: server.url,
      seed: 'replay-seed',
      headers: { 'X-Recorded': 'secret' },
      auth: { storageState: join(directory, 'missing-state.json') },
      budget: { maxActions: 40, maxDurationMs: 30_000 },
      explore: { forms: { enabled: false } },
      guardrails: { dryRun: true },
      report: { outDir: join(directory, 'recorded-out') },
    });
    const out = join(directory, 'replayed');

    const replay = await runAsync(
      ['replay', results, '--max-actions', '3', '--out', out],
      directory,
    );
    expect(replay.stderr).not.toContain('unknown option');
    expect([EXIT.CLEAN, EXIT.FINDINGS]).toContain(replay.status);
    expect(replay.stdout).toContain(`buttonmash run ${server.url} --seed replay-seed --dry-run`);

    const replayed = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as RunResult;
    expect(replayed.run.dryRun).toBe(true);
    expect(replayed.config.seed).toBe('replay-seed');
    expect(replayed.config.maxActions).toBe(3);
    expect(replayed.config.maxDurationMs).toBe(30_000);
    const resolved = replayed.resolvedConfig as unknown as ResolvedConfig;
    expect(resolved.explore.forms.enabled).toBe(false);
    expect(resolved.headers).toEqual({});
    expect(resolved.auth.storageState).toBeUndefined();
    expect(existsSync(join(directory, 'recorded-out'))).toBe(false);
  }, 90_000);
});

describe('CLI interruption', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  // Playwright installs its own SIGINT/SIGTERM handlers on launch, which close
  // the browser and exit 130 before buttonmash can write its partial report.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`writes a partial report and exits 2 on ${signal}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'buttonmash-signal-'));
      temporaryDirectories.push(directory);
      const out = join(directory, 'report');
      const child = spawn(
        process.execPath,
        [cli, 'run', server.url, '--seed', 'signal', '--max-duration', '60', '--out', out],
        { cwd: directory, env: { ...process.env, NO_COLOR: '1' } },
      );
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

      // Wait until the run loop is exploring, then interrupt it.
      for (let waited = 0; !stdout.includes('Crawl:') && waited < 30_000; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      child.kill(signal);

      expect(await exited).toBe(2);
      expect(existsSync(join(out, 'results.json'))).toBe(true);
    }, 90_000);
  }
});
