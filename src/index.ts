/**
 * Public programmatic API.
 *
 * @example
 * ```ts
 * import { buttonmash } from 'buttonmash';
 * const result = await buttonmash({ target: 'http://localhost:3000', failOn: 'high' });
 * if (result.run.exitCode !== 0) process.exit(1);
 * ```
 */
import { loadConfig, type LoadOptions } from './config/load';
import type { Config } from './config/schema';
import { runButtonmash } from './explorer/runner';
import { writeReports } from './report';
import type { RunResult } from './core/types';

export { runButtonmash } from './explorer/runner';
export { loadConfig, findConfigFile, ConfigError } from './config/load';
export type { ResolvedConfig, LoadOptions } from './config/load';
export { defineConfig, ConfigSchema, SeveritySchema } from './config/schema';
export type { Config, ParsedConfig, CustomDetector } from './config/schema';
export { writeReports } from './report';
export { redact, scanForSecrets } from './guardrails/secrets';
export { classifyControl } from './guardrails/destructive';
export { Rng } from './core/rng';
export { runDoctor } from './doctor';
export type { DoctorCheck, DoctorResult, DoctorStatus } from './doctor';
export { compareWithBaseline, isFailingFinding, loadBaseline, BaselineError } from './baseline';
export * from './core/types';
export { version } from './version';

/**
 * One-call convenience: resolve config from an object, run the monkey, write
 * reports, and return the result (with `result.run.exitCode`). Ignores any
 * `buttonmash.config.*` on disk unless you pass `loadOptions`.
 */
export async function buttonmash(
  config: Config,
  loadOptions?: Omit<LoadOptions, 'overrides'>,
): Promise<RunResult> {
  const cfg = await loadConfig({ ignoreConfigFile: true, ...loadOptions, overrides: config });
  const { result, outDir } = await runButtonmash(cfg);
  await writeReports(result, outDir, cfg);
  return result;
}
