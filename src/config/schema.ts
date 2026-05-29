/**
 * Configuration schema. A buttonmash config is intentionally "safe by default":
 * with no options beyond a target URL, the monkey stays on-origin, refuses live
 * billing, skips destructive controls, and redacts secrets.
 */
import { z } from 'zod';

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

export const BrowserSchema = z.enum(['chromium', 'firefox', 'webkit']);

const ViewportSchema = z
  .object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(800),
  })
  .default({});

const AuthSchema = z
  .object({
    /** Path to a Playwright storageState JSON (cookies + localStorage). */
    storageState: z.string().optional(),
  })
  .default({});

const BudgetSchema = z
  .object({
    /** Hard cap on total actions. */
    maxActions: z.number().int().positive().default(500),
    /** Wall-clock cap in milliseconds. */
    maxDurationMs: z.number().int().positive().default(300_000),
    /** Max link/navigation depth before resetting to the start URL. */
    maxDepth: z.number().int().positive().default(12),
    /** Stop early after this many consecutive actions reveal no new state. */
    saturationLimit: z.number().int().positive().default(80),
    /** Max distinct pages to crawl before stopping (bounds a full-site sweep). */
    maxPages: z.number().int().positive().default(100),
    /** Delay between actions so async work can settle. */
    throttleMs: z.number().int().nonnegative().default(120),
    /** Per-action wall-clock watchdog; exceeding it is recorded as a hang. */
    actionTimeoutMs: z.number().int().positive().default(15_000),
    /** Timeout for an individual Playwright interaction (click/fill/etc.). Kept
     *  short so the monkey moves on quickly from elements that aren't
     *  actionable (e.g. covered by an overlay) instead of stalling. */
    interactionTimeoutMs: z.number().int().positive().default(4_000),
    /** After each navigation, wait up to this long for the app to actually
     *  render interactive content (handles client-rendered SPAs). */
    readyTimeoutMs: z.number().int().positive().default(8_000),
  })
  .default({});

const ActionWeightsSchema = z
  .object({
    click: z.number().nonnegative().default(40),
    dblclick: z.number().nonnegative().default(4),
    type: z.number().nonnegative().default(22),
    key: z.number().nonnegative().default(8),
    hover: z.number().nonnegative().default(6),
    scroll: z.number().nonnegative().default(8),
    select: z.number().nonnegative().default(5),
    check: z.number().nonnegative().default(5),
    back: z.number().nonnegative().default(1),
    forward: z.number().nonnegative().default(1),
    resize: z.number().nonnegative().default(2),
  })
  .default({});

const ExploreSchema = z
  .object({
    /** Probability of a purely random move vs. a coverage-guided one (0..1). */
    epsilon: z.number().min(0).max(1).default(0.15),
    weights: ActionWeightsSchema,
    /** Fuzz text inputs with the safe corpus. */
    fuzzInputs: z.boolean().default(true),
    /** Auto-crawl: discover same-origin links as it explores and visit every
     *  reachable page. With this on, pointing at the site root sweeps the whole
     *  site — `routes` become optional hints for pages nothing links to. */
    crawl: z.boolean().default(true),
  })
  .default({});

const DestructiveSchema = z
  .object({
    /** Skip controls classified as destructive (delete/pay/logout/...). */
    enabled: z.boolean().default(true),
    /** Additional verbs (any language) to treat as destructive. */
    extraVerbs: z.array(z.string()).default([]),
    /** DANGEROUS: allow clicking destructive controls anyway. */
    allow: z.boolean().default(false),
  })
  .default({});

const BillingSchema = z
  .object({
    /**
     * What to do when live payment mode is detected (live Stripe/Braintree
     * keys, or outbound requests to live processor hosts):
     *  - refuse: abort the run (default, safest)
     *  - warn:   keep going but never interact with payment controls
     *  - off:    no billing detection (not recommended)
     */
    mode: z.enum(['refuse', 'warn', 'off']).default('refuse'),
  })
  .default({});

const SecretsSchema = z
  .object({
    /** Redact detected secrets in all persisted artifacts/reports. */
    redact: z.boolean().default(true),
    /** Report client-exposed secret keys (sk_/rk_/whsec_/etc.) as findings. */
    report: z.boolean().default(true),
  })
  .default({});

const GuardrailsSchema = z
  .object({
    /** Origins the monkey may navigate to. Empty → just the target's origin. */
    allowedOrigins: z.array(z.string()).default([]),
    /** Extra regex strings for paths to hard-block, even on allowed origins. */
    blockedPathPatterns: z.array(z.string()).default([]),
    destructive: DestructiveSchema,
    billing: BillingSchema,
    secrets: SecretsSchema,
    /** Read-only mode: hover/inspect/navigate but never submit or mutate. */
    dryRun: z.boolean().default(false),
    /** Block image/media/font requests to cut noise and speed runs. */
    blockMedia: z.boolean().default(true),
  })
  .default({});

const CustomDetectorSchema = z.object({
  name: z.string(),
  /** Regex (as string) matched against the chosen target text. */
  pattern: z.string(),
  severity: SeveritySchema.default('medium'),
  target: z.enum(['console', 'dom', 'url']).default('console'),
});

const DetectorsSchema = z
  .object({
    consoleErrors: z.boolean().default(true),
    consoleWarnings: z.boolean().default(false),
    httpErrors: z.boolean().default(true),
    /** HTTP statuses to ignore (e.g. expected 401/404 on probes). */
    ignoreHttpStatuses: z.array(z.number().int()).default([]),
    crashes: z.boolean().default(true),
    hangs: z.boolean().default(true),
    blankScreen: z.boolean().default(true),
    brokenImages: z.boolean().default(true),
    /** Accessibility scan via axe-core (opt-in; slower). */
    a11y: z.boolean().default(false),
    /** Reflected-input probe (safe canary, no executing payloads). */
    reflectedInput: z.boolean().default(true),
    custom: z.array(CustomDetectorSchema).default([]),
    /** Regex allowlist of benign console/network noise to ignore. */
    ignorePatterns: z.array(z.string()).default([]),
  })
  .default({});

const ReportSchema = z
  .object({
    outDir: z.string().default('buttonmash-report'),
    formats: z
      .array(z.enum(['json', 'junit', 'html', 'sarif']))
      .default(['json', 'junit', 'html']),
    /** Emit GitHub Actions annotations + job summary when running on GHA. */
    github: z.boolean().default(true),
    captureScreenshots: z.boolean().default(true),
    captureTrace: z.boolean().default(true),
    captureVideo: z.boolean().default(false),
  })
  .default({});

export const ConfigSchema = z.object({
  /** Start URL. Required, but may be supplied as the CLI argument instead. */
  target: z.string().url().optional(),
  /**
   * Additional routes to sweep in the same run (paths relative to the target,
   * or absolute same-origin URLs). The explorer rotates through target + these
   * on every reset, so one run covers deep areas (dashboards, editors) that
   * random clicking would rarely reach on its own.
   */
  routes: z.array(z.string()).default([]),
  /** Reproducibility seed. Omit for a random (but printed) seed. */
  seed: z.string().optional(),
  browser: BrowserSchema.default('chromium'),
  headless: z.boolean().default(true),
  viewport: ViewportSchema,
  auth: AuthSchema,
  budget: BudgetSchema,
  explore: ExploreSchema,
  guardrails: GuardrailsSchema,
  detectors: DetectorsSchema,
  report: ReportSchema,
  /** Minimum finding severity that fails the build (exit code 1). */
  failOn: SeveritySchema.default('high'),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
});

/** User-facing config type (all fields optional via defaults). */
export type Config = z.input<typeof ConfigSchema>;

/** Fully-parsed config with defaults applied (target still optional here). */
export type ParsedConfig = z.output<typeof ConfigSchema>;

export type CustomDetector = z.output<typeof CustomDetectorSchema>;

/**
 * Identity helper for `buttonmash.config.ts` files — gives editors full
 * autocomplete and type-checking on the config object.
 */
export function defineConfig(config: Config): Config {
  return config;
}
