import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Finding, RunResult } from '../src/core/types';
import { toSarif, writeSarifReport } from '../src/report/sarif';

const SarifResultSchema = z.object({
  ruleId: z.string().min(1),
  level: z.enum(['error', 'warning', 'note']),
  baselineState: z.enum(['new', 'updated', 'unchanged', 'absent']).optional(),
  message: z.object({ text: z.string().min(1) }),
  locations: z
    .array(
      z.object({
        physicalLocation: z.object({
          artifactLocation: z.object({ uri: z.string().min(1) }),
          region: z.object({ startLine: z.number().int().positive() }),
        }),
      }),
    )
    .min(1),
  partialFingerprints: z.record(z.string().min(1)),
});

const SarifDocumentSchema = z.object({
  $schema: z.literal('https://json.schemastore.org/sarif-2.1.0.json'),
  version: z.literal('2.1.0'),
  runs: z
    .array(
      z.object({
        tool: z.object({
          driver: z.object({
            name: z.literal('buttonmash'),
            informationUri: z.string().url(),
            version: z.string().min(1),
            rules: z.array(
              z.object({
                id: z.string().min(1),
                shortDescription: z.object({ text: z.string().min(1) }),
                properties: z.object({ tags: z.array(z.string()).min(1) }),
              }),
            ),
          }),
        }),
        results: z.array(SarifResultSchema),
      }),
    )
    .length(1),
});

function finding(over: Partial<Finding>): Finding {
  return {
    id: 'finding',
    dedupKey: 'stable-key',
    severity: 'high',
    category: 'js-error',
    title: 'Uncaught error',
    description: 'boom',
    count: 2,
    location: { url: 'https://example.test/app' },
    reproSteps: [],
    firstSeenStep: 0,
    artifacts: [],
    ...over,
  };
}

function result(findings: Finding[]): RunResult {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return {
    schemaVersion: 1,
    tool: { name: 'buttonmash', version: '0.2.0' },
    run: {
      id: 'ci',
      startedAt: '2026-07-22T00:00:00.000Z',
      finishedAt: '2026-07-22T00:00:01.000Z',
      durationMs: 1000,
      target: 'https://example.test',
      browser: 'chromium',
      viewport: { width: 1280, height: 800 },
      exitCode: 1,
      dryRun: false,
      complete: true,
    },
    config: {
      seed: 'ci',
      maxActions: 10,
      maxDurationMs: 1000,
      failOn: 'high',
      failOnNew: true,
    },
    stats: {
      actionsTaken: 1,
      pagesVisited: 1,
      statesDiscovered: 1,
      recordsCreated: 0,
      findingsBySeverity: counts,
    },
    actions: [],
    findings,
  };
}

describe('SARIF report', () => {
  it('emits levels, baseline states, fingerprints, and safe fallback URIs', () => {
    const sarif = SarifDocumentSchema.parse(
      JSON.parse(
        toSarif(
          result([
            finding({ baselineState: 'new' }),
            finding({
              dedupKey: 'updated-key',
              severity: 'medium',
              baselineState: 'updated',
              location: { url: '' },
            }),
            finding({ dedupKey: 'known-key', baselineState: 'existing' }),
          ]),
        ),
      ),
    );

    const results = sarif.runs[0]!.results;
    expect(results.map((item) => item.baselineState)).toEqual(['new', 'updated', 'unchanged']);
    expect(results.map((item) => item.level)).toEqual(['error', 'warning', 'error']);
    expect(results[0]!.partialFingerprints.primaryLocationLineHash).toBe('stable-key');
    expect(results[1]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe('unknown');
  });

  it('writes the canonical results.sarif file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buttonmash-sarif-'));
    try {
      await expect(writeSarifReport(result([]), directory)).resolves.toBe('results.sarif');
      expect(JSON.parse(readFileSync(join(directory, 'results.sarif'), 'utf8')).version).toBe(
        '2.1.0',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
