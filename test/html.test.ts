import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { buildHtml } from '../src/report/html';
import type { Finding, RunResult } from '../src/core/types';

function screenshotFinding(dedupKey: string, path: string): Finding {
  return {
    id: dedupKey,
    dedupKey,
    severity: 'high',
    category: 'js-error',
    title: `Error ${dedupKey}`,
    description: 'boom',
    count: 1,
    location: { url: 'http://localhost:3000' },
    reproSteps: [],
    firstSeenStep: 4,
    artifacts: [{ type: 'screenshot', path, mime: 'image/png' }],
  };
}

function result(over: Partial<RunResult['run']> & { seed?: string }): RunResult {
  return {
    schemaVersion: 1,
    tool: { name: 'buttonmash', version: '0.1.0' },
    run: {
      id: 'x',
      startedAt: '2026-05-28T00:00:00.000Z',
      finishedAt: '2026-05-28T00:00:01.000Z',
      durationMs: 1000,
      target: over.target ?? 'http://localhost:3000',
      browser: 'chromium',
      viewport: { width: 1280, height: 800 },
      exitCode: 0,
      dryRun: false,
    },
    config: {
      seed: over.seed ?? 'seed',
      maxActions: 1,
      maxDurationMs: 1,
      failOn: 'high',
      failOnNew: false,
    },
    stats: {
      actionsTaken: 0,
      pagesVisited: 0,
      statesDiscovered: 0,
      recordsCreated: 0,
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    actions: [],
    findings: [],
  };
}

describe('html report', () => {
  it('escapes a malicious target URL and seed in the page chrome (no XSS breakout)', () => {
    const html = buildHtml(
      result({
        target: 'http://x/?a="></code></div><script>alert(1)</script>',
        seed: '</title><script>alert(2)</script>',
      }),
      '/tmp',
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;script&gt;'); // payload was escaped
  });

  it('safely embeds the JSON blob (no </script> breakout)', () => {
    const html = buildHtml(result({ target: 'http://x/</script><b>oops' }), '/tmp');
    // the < of any </script> inside the data blob must be unicode-escaped
    expect(html).not.toContain('</script><b>oops');
  });

  it('renders baseline delta counts and resolved findings', () => {
    const report = result({});
    report.baseline = {
      source: 'previous.json',
      comparable: true,
      newFindings: 1,
      updatedFindings: 0,
      existingFindings: 2,
      resolvedFindings: [
        {
          dedupKey: 'fixed',
          severity: 'high',
          category: 'js-error',
          title: 'Fixed crash',
          location: { url: 'https://example.test/fixed' },
        },
      ],
      notObservedFindings: [],
    };

    const html = buildHtml(report, '/tmp');
    expect(html).toContain('Resolved since baseline');
    expect(html).toContain('"newFindings":1');
    expect(html).toContain('Fixed crash');
  });

  it('names the verdict, why, and what stopped the run in plain markup', () => {
    const report = result({});
    report.run.exitCode = 1;
    report.run.complete = true;
    report.run.stop = { kind: 'time-budget', reason: 'time budget reached (300s)', pagesQueued: 3 };
    report.findings = [screenshotFinding('a', 'artifacts/none.png')];

    const html = buildHtml(report, '/tmp');
    const chrome = html.slice(0, html.indexOf('<script id="data"'));
    expect(chrome).toContain('<title>buttonmash report: FAILED</title>');
    expect(chrome).toContain('<span class="badge verdict failed">FAILED</span>');
    expect(chrome).toContain('1 finding at or above high.');
    expect(chrome).toContain('time budget reached (300s), 3 pages still queued');
    expect(chrome).toContain('buttonmash replay results.json');
  });

  it('calls an interrupted run an error, not a failure', () => {
    const report = result({});
    report.run.exitCode = 2;
    report.run.complete = false;
    report.run.stop = { kind: 'aborted', reason: 'aborted (received SIGINT)', pagesQueued: 0 };

    const html = buildHtml(report, '/tmp');
    expect(html).toContain('<title>buttonmash report: ERROR</title>');
    expect(html).toContain('Partial results: aborted (received SIGINT).');
    expect(html).not.toContain('FAILED');
  });

  it('tells the client which findings fail the build', () => {
    const report = result({});
    report.run.exitCode = 1;
    const low = screenshotFinding('b', 'artifacts/none.png');
    low.severity = 'low';
    report.findings = [screenshotFinding('a', 'artifacts/none.png'), low];

    const html = buildHtml(report, '/tmp');
    expect(html).toContain('"failing":[true,false]');
    expect(html).toContain('"failRule":"at or above high"');
    expect(html).toContain('"passRule":"below high"');
  });

  it('still renders a results.json written before run.stop and pages existed', () => {
    const report = result({});
    expect(report.run.stop).toBeUndefined();
    expect(report.pages).toBeUndefined();

    const html = buildHtml(report, '/tmp');
    expect(html).toContain('<title>buttonmash report: PASSED</title>');
    expect(html).not.toContain('<dt>Stopped</dt>');
    expect(html).toContain('"queuedNote":""');
  });

  it('keeps em and en dashes out of the page chrome', () => {
    const html = buildHtml(result({}), '/tmp');
    const dashes = new RegExp('[' + String.fromCodePoint(0x2013, 0x2014) + ']');
    expect(dashes.test(html)).toBe(false);
  });

  it('inlines a screenshot shared by several findings once', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'buttonmash-html-'));
    try {
      mkdirSync(join(outDir, 'artifacts'));
      const shared = Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 37 + 11) % 256));
      const other = Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 53 + 7) % 256));
      writeFileSync(join(outDir, 'artifacts', 'step-4.png'), shared);
      writeFileSync(join(outDir, 'artifacts', 'step-9.png'), other);
      const report = result({});
      report.findings = [
        screenshotFinding('a', 'artifacts/step-4.png'),
        screenshotFinding('b', 'artifacts/step-4.png'),
        screenshotFinding('c', 'artifacts/step-9.png'),
      ];

      const html = buildHtml(report, outDir);
      const copies = (base64: string) => html.split(base64).length - 1;
      expect(copies(shared.toString('base64'))).toBe(1);
      expect(copies(other.toString('base64'))).toBe(1);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
