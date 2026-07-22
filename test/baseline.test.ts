import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BaselineError,
  baselineComparisonKey,
  compareWithBaseline,
  isFailingFinding,
  loadBaseline,
  type BaselineSnapshot,
} from '../src/baseline';
import type { BaselineFindingSummary, Finding } from '../src/core/types';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function summary(dedupKey: string, title = dedupKey): BaselineFindingSummary {
  return {
    dedupKey,
    severity: 'high',
    category: 'js-error',
    title,
    location: { url: `https://example.test/${dedupKey}` },
  };
}

function finding(dedupKey: string, severity: Finding['severity'] = 'high'): Finding {
  return {
    id: dedupKey,
    dedupKey,
    severity,
    category: 'js-error',
    title: dedupKey,
    description: dedupKey,
    count: 1,
    location: { url: `https://example.test/${dedupKey}` },
    reproSteps: [],
    firstSeenStep: 0,
    artifacts: [],
  };
}

describe('baseline comparison', () => {
  it('classifies new, existing, and resolved findings by stable dedup key', () => {
    const current = [finding('same'), finding('new')];
    const config = { target: 'https://example.test', browser: 'chromium', seed: 'ci' };
    const baseline: BaselineSnapshot = {
      source: 'previous.json',
      findings: [summary('same'), summary('fixed')],
      complete: true,
      toolVersion: '0.2.0',
      comparisonKey: baselineComparisonKey(config),
    };

    const classified = compareWithBaseline(current, baseline, {
      currentConfig: config,
      currentToolVersion: '0.2.0',
      complete: true,
    });

    expect(current.map((item) => item.baselineState)).toEqual([undefined, undefined]);
    expect(classified.findings.map((item) => item.baselineState)).toEqual(['existing', 'new']);
    expect(classified.comparison).toMatchObject({
      source: 'previous.json',
      comparable: true,
      newFindings: 1,
      updatedFindings: 0,
      existingFindings: 1,
    });
    expect(classified.comparison.resolvedFindings.map((item) => item.dedupKey)).toEqual(['fixed']);
    expect(classified.comparison.notObservedFindings).toEqual([]);
  });

  it('fails only threshold-matching new findings when failOnNew is enabled', () => {
    const existing = { ...finding('same', 'critical'), baselineState: 'existing' as const };
    const fresh = { ...finding('new', 'high'), baselineState: 'new' as const };
    const low = { ...finding('low', 'low'), baselineState: 'new' as const };

    expect(isFailingFinding(existing, 'high', true)).toBe(false);
    expect(isFailingFinding(existing, 'high', false)).toBe(true);
    expect(isFailingFinding(fresh, 'high', true)).toBe(true);
    expect(isFailingFinding(low, 'high', true)).toBe(false);
  });

  it('treats severity increases as updated regressions', () => {
    const baseline: BaselineSnapshot = {
      source: 'previous.json',
      findings: [{ ...summary('same'), severity: 'low' }],
      complete: true,
      toolVersion: '0.2.0',
    };
    const classified = compareWithBaseline([finding('same', 'critical')], baseline, {
      currentConfig: {},
      currentToolVersion: '0.2.0',
      complete: true,
    });

    expect(classified.findings[0]?.baselineState).toBe('updated');
    expect(classified.comparison.updatedFindings).toBe(1);
    expect(isFailingFinding(classified.findings[0]!, 'high', true)).toBe(true);
  });

  it('uses not-observed rather than resolved for partial or different runs', () => {
    const baseline: BaselineSnapshot = {
      source: 'previous.json',
      findings: [summary('missing')],
      complete: true,
      toolVersion: '0.2.0',
      comparisonKey: baselineComparisonKey({ seed: 'old' }),
    };
    const classified = compareWithBaseline([], baseline, {
      currentConfig: { seed: 'new' },
      currentToolVersion: '0.2.0',
      complete: true,
    });

    expect(classified.comparison.comparable).toBe(false);
    expect(classified.comparison.resolvedFindings).toEqual([]);
    expect(classified.comparison.notObservedFindings.map((item) => item.dedupKey)).toEqual([
      'missing',
    ]);
  });

  it('requires an explicit identity for auth or header-dependent comparisons', () => {
    expect(
      baselineComparisonKey({ auth: { storageState: '/tmp/user.json' }, headers: {} }),
    ).toBeUndefined();
    expect(
      baselineComparisonKey({
        auth: { storageState: '/tmp/user-a.json' },
        headers: { 'X-Tenant': 'one' },
        baseline: { identity: 'staging-admin' },
      }),
    ).toBe(
      baselineComparisonKey({
        auth: { storageState: '/tmp/user-b.json' },
        headers: { 'X-Tenant': 'two' },
        baseline: { identity: 'staging-admin' },
      }),
    );
  });

  it('loads a canonical results file and rejects malformed reports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-baseline-'));
    temporaryDirectories.push(directory);
    const valid = join(directory, 'valid.json');
    const invalid = join(directory, 'invalid.json');
    writeFileSync(
      valid,
      JSON.stringify({
        schemaVersion: 1,
        tool: { version: '0.2.0' },
        run: { exitCode: 1, complete: true },
        findings: [summary('known')],
        resolvedConfig: { seed: 'ci' },
      }),
    );
    writeFileSync(invalid, JSON.stringify({ schemaVersion: 2, findings: [] }));

    await expect(loadBaseline(valid)).resolves.toMatchObject({
      source: 'valid.json',
      findings: [{ dedupKey: 'known' }],
      complete: true,
      toolVersion: '0.2.0',
    });
    await expect(loadBaseline(invalid)).rejects.toBeInstanceOf(BaselineError);
  });
});
