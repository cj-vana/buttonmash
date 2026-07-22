import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';

import {
  ARTIFACT_DIRNAME,
  captureScreenshot,
  ensureArtifactDir,
  inlineThumb,
  startTracing,
  stopTracing,
} from '../src/capture/artifacts';
import { loadConfig } from '../src/config/load';

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'buttonmash-artifacts-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('artifact capture', () => {
  it('creates the artifact directory and safely inlines only small in-tree files', async () => {
    const artifactDir = await ensureArtifactDir(outDir);
    expect(artifactDir).toBe(join(outDir, ARTIFACT_DIRNAME));
    expect(existsSync(artifactDir)).toBe(true);

    writeFileSync(join(artifactDir, 'small.png'), Buffer.from('image'));
    writeFileSync(join(artifactDir, 'large.png'), Buffer.alloc(300_001));
    expect(inlineThumb(outDir, join(ARTIFACT_DIRNAME, 'small.png'))).toBe(
      `data:image/png;base64,${Buffer.from('image').toString('base64')}`,
    );
    expect(inlineThumb(outDir, join(ARTIFACT_DIRNAME, 'large.png'))).toBeUndefined();
    expect(inlineThumb(outDir, '../secret.txt')).toBeUndefined();
    expect(inlineThumb(outDir, 'missing.png')).toBeUndefined();
  });

  it('starts and stops tracing only when enabled and tolerates Playwright failures', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: { target: 'https://app.test', report: { captureTrace: true } },
    });
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const context = { tracing: { start, stop } } as unknown as BrowserContext;

    await startTracing(context, cfg);
    expect(start).toHaveBeenCalledWith({ screenshots: true, snapshots: true, sources: false });
    expect(await stopTracing(context, cfg, outDir)).toBe(join(ARTIFACT_DIRNAME, 'trace.zip'));

    start.mockRejectedValueOnce(new Error('trace unavailable'));
    stop.mockRejectedValueOnce(new Error('trace unavailable'));
    await expect(startTracing(context, cfg)).resolves.toBeUndefined();
    await expect(stopTracing(context, cfg, outDir)).resolves.toBeUndefined();

    const disabled = { ...cfg, report: { ...cfg.report, captureTrace: false } };
    await startTracing(context, disabled);
    expect(await stopTracing(context, disabled, outDir)).toBeUndefined();
  });

  it('returns a relative screenshot path on success and undefined on failure', async () => {
    const screenshot = vi.fn().mockResolvedValue(undefined);
    const page = { screenshot } as unknown as Page;
    expect(await captureScreenshot(page, outDir, 7)).toBe(join(ARTIFACT_DIRNAME, 'step-7.png'));
    expect(screenshot).toHaveBeenCalledWith({
      path: join(outDir, ARTIFACT_DIRNAME, 'step-7.png'),
      animations: 'disabled',
      timeout: 5_000,
    });

    screenshot.mockRejectedValueOnce(new Error('page closed'));
    expect(await captureScreenshot(page, outDir, 8)).toBeUndefined();
  });
});
