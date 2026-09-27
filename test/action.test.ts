/**
 * The composite action's shell steps, run under bash the way a `shell: bash`
 * step runs on a runner, against stub executables instead of npm and a real
 * buttonmash.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const actionYml = readFileSync(join(root, 'action.yml'), 'utf8');
const TARGET = 'http://127.0.0.1:4173';

/** The `run: |` block of the step with this id, dedented. */
function stepScript(id: string): string {
  const lines = actionYml.split('\n');
  const step = lines.indexOf(`    - id: ${id}`);
  const run = lines.findIndex((line, i) => i > step && line.trim() === 'run: |');
  if (step < 0 || run < 0) throw new Error(`action.yml has no run block for step ${id}`);
  const indent = lines[run]!.indexOf('run:') + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(indent))) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'buttonmash-action-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

interface StepResult {
  status: number | null;
  stdout: string;
  outputs: Record<string, string>;
}

function runStep(id: string, env: Record<string, string>, cwd: string): StepResult {
  const script = join(sandbox, `${id}.sh`);
  writeFileSync(script, stepScript(id));
  const outputFile = join(sandbox, 'github-output');
  writeFileSync(outputFile, '');
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: [join(sandbox, 'stubs'), dirname(process.execPath), process.env.PATH].join(delimiter),
      RUNNER_TEMP: sandbox,
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outputFile, 'utf8').split('\n').filter(Boolean)) {
    const eq = line.indexOf('=');
    outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { status: run.status, stdout: run.stdout, outputs };
}

/** Runs the `run` step against a stub buttonmash that prints its argv, one per line. */
function runButtonmash(inputs: { args?: string; failOn?: string; stubExit?: number }) {
  const bmDir = join(sandbox, 'buttonmash');
  writeExecutable(
    join(bmDir, 'node_modules', '.bin', 'buttonmash'),
    `printf '%s\\n' "$@"\nexit ${inputs.stubExit ?? 0}`,
  );
  const workspace = join(sandbox, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const step = runStep(
    'run',
    {
      BM_DIR: bmDir,
      BM_TARGET: TARGET,
      BM_BROWSER: 'chromium',
      BM_FAIL_ON: inputs.failOn ?? 'high',
      BM_ARGS: inputs.args ?? '',
      GITHUB_WORKSPACE: workspace,
    },
    workspace,
  );
  const argv = step.stdout.split('\n').slice(0, -1);
  return { ...step, argv, workspace };
}

function baseArgv(workspace: string): string[] {
  return [
    'run',
    TARGET,
    '--browser',
    'chromium',
    '--fail-on',
    'high',
    '--out',
    `${workspace}/buttonmash-report`,
  ];
}

describe('action run step: args parsing', () => {
  it('passes nothing extra for empty or blank args', () => {
    for (const args of ['', '   ']) {
      const step = runButtonmash({ args });
      expect(step.status).toBe(0);
      expect(step.argv).toEqual(baseArgv(step.workspace));
    }
  });

  it('splits plain words', () => {
    const step = runButtonmash({ args: '--seed ci --max-actions 5' });
    expect(step.argv).toEqual([...baseArgv(step.workspace), '--seed', 'ci', '--max-actions', '5']);
  });

  it('keeps a quoted value together', () => {
    const step = runButtonmash({ args: '--baseline-id "staging admin" --billing warn' });
    expect(step.argv).toEqual([
      ...baseArgv(step.workspace),
      '--baseline-id',
      'staging admin',
      '--billing',
      'warn',
    ]);
  });

  it('does not glob patterns against the runner filesystem', () => {
    const workspace = join(sandbox, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'a-file-a-glob-would-match'), '');
    const step = runButtonmash({ args: "--route '/a*' --route a*" });
    expect(step.argv).toEqual([...baseArgv(step.workspace), '--route', '/a*', '--route', 'a*']);
  });

  it('fails with exit code 2 on an unmatched quote instead of running', () => {
    const step = runButtonmash({ args: '--seed "ci' });
    expect(step.status).toBe(2);
    expect(step.outputs['exit-code']).toBe('2');
    expect(step.stdout).toMatch(/^::error::/m);
    expect(step.stdout).not.toContain(TARGET);
  });

  it('reports the buttonmash exit code and the report path', () => {
    const step = runButtonmash({ stubExit: 1 });
    expect(step.status).toBe(1);
    expect(step.outputs['exit-code']).toBe('1');
    expect(step.outputs['report-path']).toBe(`${step.workspace}/buttonmash-report`);
  });
});
