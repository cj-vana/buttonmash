/** Config discovery, merging (file < CLI overrides), validation, resolution. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { logger } from '../core/logger';
import { makeDefaultSeed } from '../core/rng';
import { ConfigSchema, type Config, type ParsedConfig } from './schema';

/** Thrown for bad config / usage; the CLI maps this to exit code 2. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Config with all required values resolved. */
export interface ResolvedConfig extends Omit<ParsedConfig, 'target' | 'seed' | 'routes'> {
  target: string;
  seed: string;
  /** Absolute, same-origin-resolved seed routes (excludes the target itself). */
  routes: string[];
  /** Absolute path of the config file used, if any. */
  configPath?: string;
}

const CONFIG_BASENAMES = [
  'buttonmash.config.ts',
  'buttonmash.config.mts',
  'buttonmash.config.js',
  'buttonmash.config.mjs',
  'buttonmash.config.cjs',
  'buttonmash.config.json',
];

/** Find a config file in `cwd`, returning its absolute path or undefined. */
export function findConfigFile(cwd = process.cwd()): string | undefined {
  for (const base of CONFIG_BASENAMES) {
    const p = resolve(cwd, base);
    if (existsSync(p)) return p;
  }
  return undefined;
}

async function loadConfigFile(path: string): Promise<Config> {
  if (path.endsWith('.json')) {
    const raw = await readFile(path, 'utf8');
    try {
      return JSON.parse(raw) as Config;
    } catch (err) {
      throw new ConfigError(`Failed to parse JSON config ${path}: ${(err as Error).message}`);
    }
  }
  // TS / ESM / CJS — load via jiti so .ts works without a build step.
  try {
    const { createJiti } = await import('jiti');
    const jiti = createJiti(pathToFileURL(__filenameSafe()).href);
    const mod = (await jiti.import(path)) as { default?: Config } & Config;
    return (mod.default ?? mod) as Config;
  } catch (err) {
    throw new ConfigError(`Failed to load config ${path}: ${(err as Error).message}`);
  }
}

/** import.meta.url is unavailable post-bundle in some shims; fall back safely. */
function __filenameSafe(): string {
  try {
    return process.argv[1] ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge plain objects; arrays and primitives from `over` replace `base`. */
function deepMerge<T>(base: T, over: Partial<T> | undefined): T {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return (over as T) ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] =
      isPlainObject(v) && isPlainObject(out[k])
        ? deepMerge(out[k], v as Record<string, unknown>)
        : v;
  }
  return out as T;
}

export interface LoadOptions {
  /** Explicit config file path (skips discovery). */
  configPath?: string;
  /** CLI-derived overrides applied on top of the file. */
  overrides?: Partial<Config>;
  cwd?: string;
  /** Skip config-file discovery entirely (for programmatic use). */
  ignoreConfigFile?: boolean;
  /** List flags documented as *additive* (`--route`, `--allow-origin`): these
   *  append to the file's lists instead of replacing them like `overrides`
   *  arrays do (deepMerge replaces arrays wholesale). */
  append?: { routes?: string[]; allowedOrigins?: string[] };
}

/**
 * Load + merge + validate + resolve a config. Throws {@link ConfigError} on
 * any problem the user can fix (missing target, bad file, schema violation).
 */
export async function loadConfig(opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.ignoreConfigFile
    ? undefined
    : opts.configPath
      ? resolve(cwd, opts.configPath)
      : findConfigFile(cwd);

  if (opts.configPath && !existsSync(configPath!)) {
    throw new ConfigError(`Config file not found: ${opts.configPath}`);
  }

  const fileConfig: Config = configPath ? await loadConfigFile(configPath) : {};
  const merged = deepMerge<Config>(fileConfig, opts.overrides);

  if (opts.append?.routes?.length) {
    merged.routes = [...new Set([...(merged.routes ?? []), ...opts.append.routes])];
  }
  if (opts.append?.allowedOrigins?.length) {
    merged.guardrails = {
      ...merged.guardrails,
      allowedOrigins: [
        ...new Set([...(merged.guardrails?.allowedOrigins ?? []), ...opts.append.allowedOrigins]),
      ],
    };
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }

  const cfg = parsed.data;

  // Interpolate ${ENV_VAR} in credentials/headers so secrets stay out of config.
  // A missing variable is loud: silently substituting '' means logging in with
  // an empty password and burning the whole budget against the login page.
  const interp = (s: string): string =>
    s.replace(/\$\{(\w+)\}/g, (_m, k: string) => {
      const v = process.env[k];
      if (v === undefined) logger.warn(`Config references \${${k}} but it is not set — using ''.`);
      return v ?? '';
    });
  if (cfg.auth.loginScript) {
    cfg.auth.loginScript.username = interp(cfg.auth.loginScript.username);
    cfg.auth.loginScript.password = interp(cfg.auth.loginScript.password);
  }
  if (cfg.auth.basicAuth) {
    cfg.auth.basicAuth.username = interp(cfg.auth.basicAuth.username);
    cfg.auth.basicAuth.password = interp(cfg.auth.basicAuth.password);
  }
  for (const k of Object.keys(cfg.headers)) cfg.headers[k] = interp(cfg.headers[k]!);

  let target: string | undefined = cfg.target;
  if (!target) {
    throw new ConfigError(
      'No target URL. Pass one as `buttonmash run <url>` or set `target` in your config.',
    );
  }

  let origin: string;
  try {
    const tu = new URL(target);
    // Credentials in the URL would be persisted verbatim into every report
    // (results.json, junit.xml, the HTML header, CI annotations) — move them
    // into basicAuth, which the report writer redacts.
    if (tu.username || tu.password) {
      cfg.auth.basicAuth ??= {
        username: decodeURIComponent(tu.username),
        password: decodeURIComponent(tu.password),
      };
      tu.username = '';
      tu.password = '';
      target = tu.toString();
      logger.warn(
        'Credentials in the target URL were moved to auth.basicAuth and stripped from reports.',
      );
    }
    origin = tu.origin;
  } catch {
    throw new ConfigError(`Invalid target URL: ${target}`);
  }

  // Resolve seed routes against the target origin (relative or absolute).
  const routes: string[] = [];
  for (const r of cfg.routes) {
    try {
      const ru: URL = new URL(r, target);
      ru.username = '';
      ru.password = '';
      const u: string = ru.toString();
      if (u !== target) routes.push(u);
    } catch {
      throw new ConfigError(`Invalid route: ${r}`);
    }
  }
  const routeOrigins = routes.map((r) => new URL(r).origin);

  // Default the origin allowlist to the target's origin; always include it and
  // any route origins.
  const baseAllowed = cfg.guardrails.allowedOrigins.length
    ? [...cfg.guardrails.allowedOrigins, origin]
    : [origin];
  const allowedOrigins = Array.from(new Set([...baseAllowed, ...routeOrigins]));

  return {
    ...cfg,
    target,
    routes,
    seed: cfg.seed ?? makeDefaultSeed(),
    baseline: {
      ...cfg.baseline,
      path: cfg.baseline.path ? resolve(cwd, cfg.baseline.path) : undefined,
    },
    guardrails: { ...cfg.guardrails, allowedOrigins },
    configPath,
  };
}
