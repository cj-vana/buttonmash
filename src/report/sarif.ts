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
          // GitHub rejects the whole SARIF upload on a schema violation; ensure
          // the uri is a valid URI reference (page.url() can be empty).
          const uri = /^[a-z][a-z0-9+.-]*:/i.test(f.location.url) ? f.location.url : 'unknown';
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
            message: { text: `${f.title} (seen ${f.count}×)` },
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
