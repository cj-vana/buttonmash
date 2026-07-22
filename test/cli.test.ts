import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli-program';

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

  it('uses exit code 2 for invalid usage before launching a browser', () => {
    const result = run(['run', 'https://example.test', '--fail-on', 'apocalyptic']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--fail-on must be one of');
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
