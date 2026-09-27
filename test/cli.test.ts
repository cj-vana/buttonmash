import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli-program';
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
