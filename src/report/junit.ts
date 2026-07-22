/**
 * JUnit XML — the de-facto format CI systems parse for pass/fail. We emit
 * correct <failure> child elements (not just count attributes), escape entities,
 * and strip control characters illegal in XML 1.0 (fuzz payloads are full of
 * them). Each testcase name is unique (dedupKey suffix) so CIs that dedup by
 * name don't silently drop findings.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isFailingFinding } from '../baseline';
import { EXIT, type Finding, type RunResult } from '../core/types';

export function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // eslint-disable-next-line no-control-regex -- intentionally stripping chars illegal in XML 1.0
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      // also strip XML 1.0 noncharacters and unpaired surrogates (reflected app text)
      .replace(/[￾￿]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
      .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
  );
}

function reproText(f: Finding): string {
  const steps = f.reproSteps
    .map(
      (s) =>
        `  #${s.step} ${s.kind}${s.target ? ` "${s.target}"` : ''}${s.value ? ` = ${s.value}` : ''}`,
    )
    .join('\n');
  return `${f.description}\n\nLocation: ${f.location.url}\nSeen ${f.count}× (first at action #${f.firstSeenStep})\n\nRepro:\n${steps}`;
}

export function toJUnit(result: RunResult): string {
  const { findings } = result;
  const suiteName = `buttonmash (${result.run.target})`;
  const runFailed = result.run.exitCode === EXIT.ERROR || result.run.complete === false;

  const cases: string[] = [];
  if (runFailed) {
    const toolError = result.run.exitCode === EXIT.ERROR;
    const message = toolError
      ? `buttonmash tool error or interruption (exit ${result.run.exitCode})`
      : `buttonmash run did not complete successfully (exit ${result.run.exitCode})`;
    const failureType = toolError ? 'buttonmash:tool-error' : 'buttonmash:incomplete-run';
    cases.push(
      `    <testcase name="buttonmash tool error/incomplete run" classname="buttonmash" time="${(result.run.durationMs / 1000).toFixed(3)}">\n` +
        `      <failure message="${xmlEscape(message)}" type="${failureType}">${xmlEscape(
          `Target: ${result.run.target}\nSeed: ${result.config.seed}\nComplete: ${String(result.run.complete === true)}`,
        )}</failure>\n` +
        `    </testcase>`,
    );
  }
  if (findings.length === 0 && !runFailed) {
    cases.push(
      `    <testcase name="buttonmash run (seed ${xmlEscape(result.config.seed)})" classname="buttonmash" time="${(result.run.durationMs / 1000).toFixed(3)}"/>`,
    );
  } else if (findings.length > 0) {
    for (const f of findings) {
      const name = xmlEscape(`${f.title} [${f.dedupKey}]`);
      const type = xmlEscape(`${f.severity}:${f.category}`);
      const msg = xmlEscape(f.title);
      // The [[ATTACHMENT|…]] convention surfaces screenshots in Jenkins/GitLab/
      // CircleCI test UIs that would otherwise show text only.
      const attachments = f.artifacts
        .filter((a) => a.type === 'screenshot')
        .map((a) => `      <system-out>[[ATTACHMENT|${xmlEscape(a.path)}]]</system-out>\n`)
        .join('');
      const failing = isFailingFinding(f, result.config.failOn, result.config.failOnNew ?? false);
      const outcome = failing
        ? `      <failure message="${msg}" type="${type}">${xmlEscape(reproText(f))}</failure>\n`
        : `      <skipped message="${xmlEscape(
            f.baselineState === 'existing'
              ? 'existing baseline finding'
              : `below ${result.config.failOn} failure threshold`,
          )}"/>\n`;
      cases.push(
        `    <testcase name="${name}" classname="buttonmash.${xmlEscape(f.category)}" time="0">\n` +
          outcome +
          attachments +
          `    </testcase>`,
      );
    }
  }

  const findingFailures = findings.filter((finding) =>
    isFailingFinding(finding, result.config.failOn, result.config.failOnNew ?? false),
  ).length;
  const failures = findingFailures + (runFailed ? 1 : 0);
  const skipped = findings.length - findingFailures;
  const total = Math.max(1, findings.length + (runFailed ? 1 : 0));
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="${xmlEscape(suiteName)}" tests="${total}" failures="${failures}" skipped="${skipped}">\n` +
    `  <testsuite name="${xmlEscape(suiteName)}" tests="${total}" failures="${failures}" skipped="${skipped}" timestamp="${result.run.startedAt}" time="${(result.run.durationMs / 1000).toFixed(3)}">\n` +
    `${cases.join('\n')}\n` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}

export async function writeJUnitReport(result: RunResult, outDir: string): Promise<string> {
  const rel = 'junit.xml';
  await writeFile(join(outDir, rel), toJUnit(result), 'utf8');
  return rel;
}
