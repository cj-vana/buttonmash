# 🐒 buttonmash

[![CI](https://github.com/cj-vana/buttonmash/actions/workflows/ci.yml/badge.svg)](https://github.com/cj-vana/buttonmash/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/buttonmash.svg)](https://www.npmjs.com/package/buttonmash)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**A CI chaos monkey for web apps.** Point it at your site and it **crawls every
page on its own** — discovering links and in-app (SPA) navigations as it goes —
then on each page finds every button/link/input and mashes them: clicking,
double-clicking, typing random keystrokes, selecting, scrolling, resizing,
navigating. It even **completes create-flows** — filling forms with valid data
and submitting them — so empty apps populate themselves and deep editors get
exercised. When something breaks (an uncaught error, a 500, a crash, a blank
screen, a broken image…) it writes a report and **fails your build**.

It's deterministic (seeded, so any failure replays), bounded (action/time
budgets), and **safe by default**: it stays on your origin, skips destructive
controls, refuses to run against live payment keys, and redacts secrets.

```bash
npx buttonmash run https://staging.example.com
```

> [!WARNING]
> **Point this at a test/staging environment, never production.** A random
> clicker mutates state. Use **Stripe/PayPal test mode** and test cards. buttonmash
> tries hard to avoid damage (see [Safety](#-safety)), but those are guardrails,
> not guarantees — the real safety control is running against a disposable
> environment with test-mode billing.

---

## Why

Existing in-page monkeys (gremlins.js and friends) inject synthetic events and
**never actually fail your CI** — they just log to the console. buttonmash flips
that around: it drives the page from the **harness** side with Playwright, so it
owns the verdict and the exit code. It also enumerates real elements (so it hits
buttons below the fold, unlike coordinate-based clickers), dispatches **trusted**
input, and deduplicates findings into an actionable report with a reproducible
seed.

## Install

```bash
npm install --save-dev buttonmash
npx playwright install --with-deps chromium   # one-time browser install
```

Requires Node 20+.

## Quickstart

```bash
# 1. (optional) capture an authenticated session — opens a browser, you log in
npx buttonmash auth https://staging.example.com/login
#    → saves cookies/localStorage to playwright/.auth/user.json

# 2. scaffold a config (optional)
npx buttonmash init

# 3. run it
npx buttonmash run https://staging.example.com --auth playwright/.auth/user.json

# 4. reproduce a failure exactly (the seed is printed on every run)
npx buttonmash run https://staging.example.com --seed <seed-from-report>
```

When it finishes you get a `buttonmash-report/` folder with `report.html`
(self-contained), `results.json`, and `junit.xml`. Exit code is `1` if anything
broke at or above your fail threshold.

## Use in CI (GitHub Actions)

The quickest way is the bundled composite action (installs the browser + runs
buttonmash + uploads the report):

```yaml
name: buttonmash
on: [pull_request]
jobs:
  buttonmash:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v5
      # start your app under test here (e.g. npm ci && npm run start &) and wait for it…
      - uses: cj-vana/buttonmash@v0.1.8
        with:
          target: http://localhost:3000
          args: --seed ci --max-actions 800
```

Or wire it by hand for full control:

```yaml
name: buttonmash
on: [pull_request]
jobs:
  buttonmash:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      # start your app under test here (e.g. npm run start &) and wait for it…
      - run: npx buttonmash run http://localhost:3000 --seed ci --fail-on high
        env:
          # storageState captured locally and stored as a secret (base64 or file)
          STORAGE_STATE: ${{ secrets.BUTTONMASH_STORAGE_STATE }}
      - uses: actions/upload-artifact@v5
        if: ${{ !cancelled() }}
        with: { name: buttonmash-report, path: buttonmash-report/ }
```

buttonmash auto-detects GitHub Actions and emits inline annotations plus a job-summary
table. The non-zero exit code fails the job.

## Crawling the whole site

By default buttonmash **auto-crawls**: starting from your target, it discovers
every same-origin `<a href>` link *and* every client-side route the app
navigates to via buttons/`navigate()` (it hooks `pushState`/`popstate`), queues
them, and works through them breadth-first. When the link frontier runs dry it
returns to the start and keeps clicking — so button-driven SPA shells (where the
nav isn't `<a href>`) still get fully covered. One run, the whole reachable site:

```bash
npx buttonmash run https://staging.example.com   # crawls everything it can reach
```

Controls:

- `budget.maxPages` — cap on distinct pages per run (default 100), so CI stays bounded.
- `routes` — optional **hints**: pages nothing links to (e.g. a deep editor URL).
  They seed the frontier; the crawl finds the rest. Also available as `--route <url...>`.
- `explore.crawl: false` — disable auto-crawl and only sweep `target` + `routes`.

Dangerous paths (logout/delete/cancel) and off-origin URLs are never enqueued.

Hash-router SPAs are first-class: `#/route` and `#!/route` fragments count as
distinct pages in the frontier and stats (plain `#anchor` fragments don't), and
path guards like `blockedPathPatterns` apply to the hash route too — a
`#/account/delete` link is guarded exactly like `/account/delete`.

Discovery also reaches **inside open shadow DOM** (web-component design systems —
Salesforce LWC, Ionic, Shoelace/Lit/Material Web) and **same-origin iframes**
(embedded editors, wizards), so component-based apps aren't invisible to it.

It's built to survive messy real apps on long CI sweeps: it **recovers from
renderer crashes** (recreates the page and continues, skipping the page that
crashed), opens **custom ARIA dropdowns** and picks an option, **declines file
pickers** so a file input can't hang the run, and you can **scope the crawl**
with `guardrails.includePaths` / `excludePaths`.

## Self-populating (form completion)

A fresh app is mostly empty lists — so buttonmash **creates its own data**. When
it finds a fillable form (or opens a "New/Add/Create" flow), it fills every
required field — and a fraction of optional ones — with **valid, deterministic**
values inferred from each field's type/label/pattern/min-max/options (real
emails, in-range numbers, seeded dates, a chosen `<select>` option, mirrored
password-confirm), clicks the form's **safe** submit, repairs on validation
errors, and follows into the created record so deep editors get exercised. No
per-site config — detection is structural, so it works on any app.

It stays safe by reusing the same guardrails: it **never submits** a form with a
credit-card field, an auth/login/signup form (would mutate your session), or one
whose submit is destructive — and the network fence still blocks live payments.
One free-text field per form carries a reflected-input canary, so created
records still feed the XSS oracle. Bounded by `explore.forms.maxRecords`;
`--dry-run` fills but never submits. Turn it off with `explore.forms.enabled: false`.

## Configuration

Create `buttonmash.config.ts` (or `.js`/`.json`) — `buttonmash init` writes a
starter. CLI flags override the file.

```ts
import { defineConfig } from 'buttonmash';

export default defineConfig({
  target: 'https://staging.example.com',
  seed: 'ci',

  // Auth: a saved session…
  auth: { storageState: 'playwright/.auth/user.json' },
  // …or a scriptable login (CI-friendly; re-authenticates if the session drops
  // mid-run). Credentials support ${ENV_VAR} so secrets stay out of the file:
  // auth: {
  //   loginScript: {
  //     url: '/login', usernameSelector: '#email', passwordSelector: '#password',
  //     submitSelector: 'button[type=submit]', username: '${E2E_USER}', password: '${E2E_PASS}',
  //     successUrl: '/dashboard',
  //   },
  // },

  budget: { maxActions: 500, maxDurationMs: 300_000, maxDepth: 12, maxPages: 100 },

  // Point it at any deployment: extra headers (auth proxy / feature flags),
  // HTTP basic-auth, and a device viewport. ${ENV_VAR} keeps secrets in env.
  // headers: { 'X-Feature-Flag': 'on', Authorization: 'Bearer ${API_TOKEN}' },
  // viewport: { width: 390, height: 844 }, // mobile
  // auth: { basicAuth: { username: '${BASIC_USER}', password: '${BASIC_PASS}' } },

  // Auto-crawl is on by default; `routes` are optional hints for pages nothing
  // links to (e.g. a deep editor). The crawl discovers everything else.
  // routes: ['/dashboard', '/settings/billing'],
  explore: { crawl: true },

  guardrails: {
    // allowedOrigins: ['https://staging.example.com'], // defaults to target origin
    // includePaths: ['^/app/'],     // scope the crawl (regex on pathname)
    // excludePaths: ['/admin'],     // never crawl these
    billing: { mode: 'refuse' },   // refuse | warn | off
    // dryRun: true,                // read-only: explore without submitting
    destructive: { enabled: true, extraVerbs: ['archivar'] },
  },

  detectors: {
    a11y: false,                    // opt-in axe-core scan
    ignoreHttpStatuses: [401, 403],
    ignorePatterns: ['ResizeObserver loop'], // benign console/network noise (regex)
    custom: [{ name: 'error-boundary', pattern: 'Something went wrong', severity: 'high', target: 'console' }],
  },

  failOn: 'high',                   // critical | high | medium | low | info
});
```

### Common CLI flags

| Flag | Description |
|---|---|
| `--seed <s>` | Reproducibility seed (printed every run) |
| `--route <url...>` | Extra route hints to sweep in the same run (crawl finds the rest) |
| `--max-actions <n>` / `--max-duration <sec>` | Budget |
| `--fail-on <severity>` | Min severity that fails the build (default `high`) |
| `--dry-run` | Read-only: explore without submitting or mutating |
| `--auth <path>` | Playwright storageState JSON |
| `--billing <refuse\|warn\|off>` | Live-payment guard |
| `--browser <chromium\|firefox\|webkit>` | Engine |
| `--headed` | Show the browser |
| `--out <dir>` / `--formats json,junit,html,sarif` | Reporting |

## What it detects

- **Uncaught JS errors** and `console.error`
- **HTTP 4xx/5xx** responses and failed requests
- **Renderer crashes** and **hangs / unresponsive pages** (wall-clock watchdog)
- **Framework error overlays** (Next.js/Vite/React, "Application error") — caught even when an error boundary swallows the throw
- **Blank screens** ("white screen of death") and **broken images**
- **Reflected input** — a safe canary probe that flags possible XSS sinks (never injects executing payloads)
- **Client-exposed secrets** (Stripe/AWS/GitHub/Slack/… keys, gitleaks-derived)
- **Accessibility** violations via axe-core (opt-in)
- **Session loss** — if an authed run gets redirected to a login page mid-run (expired session), it flags it and re-authenticates when a login script is configured
- **Custom signals** — your own console/DOM/url regex rules

Findings are **deduplicated** (the same bug firing 500× becomes one finding with
`count: 500`) and carry a minimal repro trace. To stay usable on real apps,
buttonmash ships a **default allowlist** of benign console noise (ResizeObserver
loops, React dev warnings, HMR…) and **downgrades third-party `console.error`**
(analytics/chat/payment SDKs) so they don't redden your build — first-party
errors stay high (`detectors.thirdPartyConsole: true` to opt in). State dedup is
**structural** by default, so live counters/clocks don't explode the state space
on dynamic apps. And if CI cancels or times out mid-run, a **partial report is
still written** (SIGTERM-safe) so you never lose the findings collected so far.

## 🛡 Safety

buttonmash is built to break things without breaking *you*:

- **Stay on origin.** Off-origin navigations and `target=_blank` popups are
  blocked; the session is fenced to your allowed origins.
- **Skip destructive controls.** Buttons/links matching a multilingual verb
  list (delete, pay, logout, cancel subscription, …), or pointing at dangerous
  paths (`/logout`, `/account/delete`, `/billing/cancel`), are detected and
  downgraded to a harmless hover.
- **Refuse live billing.** If live Stripe/Braintree keys or live processor hosts
  are detected, buttonmash aborts (`billing.mode: 'refuse'`) and tells you to switch
  to test mode. Publishable test keys are fine.
- **Redact secrets.** Anything matching a secret pattern is scrubbed before it's
  written to any report or artifact; auth/cookie headers are never persisted.
- **Dismiss, never confirm.** Native `confirm()`/`beforeunload` dialogs are
  always dismissed, so the monkey can't click "Yes, delete".
- **Dry-run mode.** `--dry-run` explores read-only: hover, scroll, navigate
  links — no form submits, typing, or mutations.

## Reports & exit codes

Every run writes `results.json` (the source of truth). Optionally `junit.xml`
(for CI test rendering), a self-contained `report.html`, and `results.sarif`
(for GitHub code-scanning). On GitHub Actions it additionally emits inline
`::error` annotations for the top findings and a markdown job summary — no
setup needed. Exit codes follow the pytest/ESLint convention:

| Code | Meaning |
|---|---|
| `0` | No findings at/above the fail threshold |
| `1` | Findings at/above the threshold — **the build-failing signal** |
| `2` | buttonmash itself errored (bad config/usage/internal) |

## Reproducibility

Every choice — which element, which action, which input — flows through a single
seeded PRNG, and the in-page `Math.random` is seeded identically. The seed is
printed at startup and embedded in every report, and replaying it makes the
monkey take the **same decisions**.

Caveat worth knowing: the page clock is **deliberately not frozen** (freezing
time breaks many real apps). So replay is reliable for apps whose rendered DOM
is stable given the same inputs; apps with heavy async-loaded content, polling,
or wall-clock/`Math.random`-driven rendering can still diverge, because a
different DOM at a step changes what the monkey sees and therefore what it picks
next. Pinning the seed in CI plus a stable build gets you most of the way.

## Programmatic API

```ts
import { buttonmash } from 'buttonmash';

const result = await buttonmash({ target: 'http://localhost:3000', failOn: 'high' });
console.log(result.stats, result.findings);
if (result.run.exitCode !== 0) process.exit(1);
```

## How it works

```
launch (Playwright) → auth (storageState) → fence (origin/dialogs/popups)
  → crawl frontier (target + routes; grows with discovered links + SPA navs)
  → per page: discover interactive elements → fingerprint state (coverage)
          → choose element (epsilon-greedy) → gate (safety) → perform action
          → log trace → capture artifacts on signal
          → when exhausted, move to the next page in the frontier
  → aggregate + dedupe → report (json/junit/html/sarif) → exit code
```

## Limitations

- Reaches open shadow roots and same-origin iframes, but not **closed** shadow
  roots or **cross-origin** iframes (payment iframes are intentionally left
  alone).
- Pure random/coverage exploration can under-explore deep multi-step flows.
- Heuristic destructive detection covers English, Spanish, German, French,
  Japanese, Chinese, Korean, Russian, and Arabic verbs; extend
  `destructive.extraVerbs` for your UI. **Sandbox + test mode is the real safety
  net.**

## Development

```bash
npm install
npm run build        # tsup → dist/
npm test             # vitest (unit + e2e against the bundled buggy app)
npm run typecheck && npm run lint
```

The `examples/buggy-app/` is a deliberately broken page used to dogfood the tool
in CI.

## Related

[unslop-ci](https://github.com/cj-vana/unslop-ci) is buttonmash's sibling: a
diff-aware CI gate that scans only the lines a PR adds for the tells that make
code, prose, and UI read as AI-generated. buttonmash tests what the running
app does; unslop-ci gates what the diff says.

## License

[MIT](./LICENSE) © cj-vana
