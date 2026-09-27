/**
 * SARIF 2.1.0 — for surfacing security-relevant findings as GitHub Code
 * Scanning alerts with cross-run dedup. Opt-in (not in default formats).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunResult, Severity } from '../core/types';

function level(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note';
}

/**
 * A repo-relative artifact path for a page: host plus path, no scheme or port.
 * upload-sarif sends a file:// source root, and GitHub rejects the whole upload
 * when any artifact URI uses another scheme, so a page URL can't go here as-is
 * (and `localhost:3000/x` would itself parse as scheme `localhost`).
 */
function pageArtifactPath(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    if (!u.hostname) return 'unknown';
    // An IPv6 host (`[::1]`) would put colons in the first path segment too.
    const host = u.hostname.replace(/[[\]]/g, '').replace(/:/g, '-');
    return `${host}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return 'unknown';
  }
}

export function toSarif(result: RunResult): string {
  const ruleIds = [...new Set(result.findings.map((f) => f.category))];
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'buttonmash',
            informationUri: 'https://github.com/cj-vana/buttonmash',
            version: result.tool.version,
            rules: ruleIds.map((id) => ({
              id,
              shortDescription: { text: id },
              properties: { tags: ['fuzzing', 'ui'] },
            })),
          },
        },
        results: result.findings.map((f) => {
          const uri = pageArtifactPath(f.location.url);
          return {
            ruleId: f.category,
            level: level(f.severity),
            ...(f.baselineState
              ? {
                  baselineState:
                    f.baselineState === 'existing'
                      ? 'unchanged'
                      : f.baselineState === 'updated'
                        ? 'updated'
                        : 'new',
                }
              : {}),
            message: {
              text: `${f.title} (seen ${f.count}×${f.location.url ? ` on ${f.location.url}` : ''})`,
            },
            properties: { pageUrl: f.location.url },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri },
                  region: { startLine: 1 },
                },
              },
            ],
            partialFingerprints: { primaryLocationLineHash: f.dedupKey },
          };
        }),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

export async function writeSarifReport(result: RunResult, outDir: string): Promise<string> {
  const rel = 'results.sarif';
  await writeFile(join(outDir, rel), toSarif(result), 'utf8');
  return rel;
}
