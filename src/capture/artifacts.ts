/**
 * Failure artifacts: a Playwright trace for the whole run plus per-step
 * screenshots taken whenever new signals appear. Screenshots small enough to
 * inline are embedded as thumbnails in the HTML report; the rest are referenced
 * by path.
 */
import { readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { BrowserContext, Page } from 'playwright';

import type { ResolvedConfig } from '../config/load';
import { withDeadline } from '../core/async';

const THUMB_INLINE_LIMIT = 300_000; // bytes

export const ARTIFACT_DIRNAME = 'artifacts';

export async function startTracing(context: BrowserContext, cfg: ResolvedConfig): Promise<void> {
  if (!cfg.report.captureTrace) return;
  await context.tracing
    .start({ screenshots: true, snapshots: true, sources: false })
    .catch(() => {});
}

export async function stopTracing(
  context: BrowserContext,
  cfg: ResolvedConfig,
  outDir: string,
): Promise<string | undefined> {
  if (!cfg.report.captureTrace) return undefined;
  const rel = join(ARTIFACT_DIRNAME, 'trace.zip');
  try {
    await context.tracing.stop({ path: join(outDir, rel) });
    return rel;
  } catch {
    return undefined;
  }
}

export async function ensureArtifactDir(outDir: string): Promise<string> {
  const dir = join(outDir, ARTIFACT_DIRNAME);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Take a viewport screenshot for a step. Returns the report-relative path. */
export async function captureScreenshot(
  page: Page,
  outDir: string,
  step: number,
): Promise<string | undefined> {
  const rel = join(ARTIFACT_DIRNAME, `step-${step}.png`);
  try {
    await withDeadline(
      page.screenshot({ path: join(outDir, rel), animations: 'disabled', timeout: 5_000 }),
      8_000,
      'screenshot',
    );
    return rel;
  } catch {
    return undefined;
  }
}

/** Read a small image as a data URI for inlining; undefined if too big/missing.
 *  Refuses paths that escape the report directory — the public API accepts an
 *  arbitrary RunResult, and a hostile artifact path must not inline `../.env`
 *  into the report. */
export function inlineThumb(outDir: string, relPath: string, mime = 'image/png'): string | undefined {
  try {
    const abs = resolve(outDir, relPath);
    if (!abs.startsWith(resolve(outDir) + sep)) return undefined;
    if (statSync(abs).size > THUMB_INLINE_LIMIT) return undefined;
    return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
  } catch {
    return undefined;
  }
}
