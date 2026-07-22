import { describe, it, expect } from 'vitest';
import { toJUnit, xmlEscape } from '../src/report/junit';
import type { Finding, RunResult } from '../src/core/types';

function baseResult(findings: Finding[]): RunResult {
  return {
    schemaVersion: 1,
    tool: { name: 'buttonmash', version: '0.1.0' },
    run: {
      id: 'seed',
      startedAt: '2026-05-28T00:00:00.000Z',
      finishedAt: '2026-05-28T00:00:05.000Z',
      durationMs: 5000,
      target: 'http://localhost:3000',
      browser: 'chromium',
      viewport: { width: 1280, height: 800 },
      exitCode: findings.length ? 1 : 0,
      dryRun: false,
      complete: true,
    },
    config: {
      seed: 'seed',
      maxActions: 100,
      maxDurationMs: 1000,
      failOn: 'high',
      failOnNew: false,
    },
    stats: {
      actionsTaken: 10,
      pagesVisited: 1,
      statesDiscovered: 1,
      recordsCreated: 0,
      findingsBySeverity: { critical: 0, high: findings.length, medium: 0, low: 0, info: 0 },
    },
    actions: [],
    findings,
  };
}

function finding(over: Partial<Finding>): Finding {
  return {
    id: 'k',
    dedupKey: 'k',
    severity: 'high',
    category: 'js-error',
    title: 'Uncaught error',
    description: 'boom',
    count: 1,
    location: { url: 'http://localhost:3000' },
    reproSteps: [],
    firstSeenStep: 0,
    artifacts: [],
    ...over,
  };
}

describe('junit', () => {
  it('escapes entities and strips illegal control chars', () => {
    expect(xmlEscape('a<b>&"\'')).toBe('a&lt;b&gt;&amp;&quot;&apos;');
    const withControls = 'x' + String.fromCharCode(7) + String.fromCharCode(0) + 'yz';
    expect(xmlEscape(withControls)).toBe('xyz');
  });

  it('emits a passing testcase for a clean run', () => {
    const xml = toJUnit(baseResult([]));
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('<testcase');
    expect(xml).not.toContain('<failure');
  });

  it('emits a failure element per finding with unique names', () => {
    const xml = toJUnit(
      baseResult([
        finding({ dedupKey: 'aaa', title: 'Error A' }),
        finding({ dedupKey: 'bbb', title: 'Error B' }),
      ]),
    );
    expect(xml).toContain('failures="2"');
    expect((xml.match(/<failure /g) ?? []).length).toBe(2);
    expect(xml).toContain('[aaa]');
    expect(xml).toContain('[bbb]');
  });

  it('escapes nasty titles instead of emitting raw markup', () => {
    const xml = toJUnit(baseResult([finding({ title: 'bad <script> & "stuff"' })]));
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).not.toContain('<script>');
  });

  it('treats existing findings as skipped when only new findings fail', () => {
    const result = baseResult([
      finding({ dedupKey: 'known', baselineState: 'existing' }),
      finding({ dedupKey: 'fresh', baselineState: 'new' }),
    ]);
    result.config.failOnNew = true;

    const xml = toJUnit(result);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('existing baseline finding');
  });

  it('emits a failure when the tool exits with an error and has no findings', () => {
    const result = baseResult([]);
    result.run.exitCode = 2;
    result.run.complete = false;

    const xml = toJUnit(result);
    expect(xml).toContain('tests="1" failures="1"');
    expect(xml).toContain('buttonmash tool error/incomplete run');
    expect(xml).toContain('type="buttonmash:tool-error"');
  });

  it('adds an incomplete-run failure alongside skipped baseline findings', () => {
    const result = baseResult([finding({ baselineState: 'existing' })]);
    result.config.failOnNew = true;
    result.run.exitCode = 1;
    result.run.complete = false;

    const xml = toJUnit(result);
    expect(xml).toContain('tests="2" failures="1" skipped="1"');
    expect(xml).toContain('type="buttonmash:incomplete-run"');
    expect(xml).toContain('existing baseline finding');
  });
});
