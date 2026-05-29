# 🐒 buttonmash

[![CI](https://github.com/cj-vana/buttonmash/actions/workflows/ci.yml/badge.svg)](https://github.com/cj-vana/buttonmash/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/buttonmash.svg)](https://www.npmjs.com/package/buttonmash)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**A CI chaos monkey for web apps.** buttonmash drives a real browser, finds every
button/link/input it can, and mashes them — clicking, double-clicking, typing
random keystrokes, selecting, scrolling, resizing, navigating — trying to break
your UI. When something breaks (an uncaught error, a 500, a crash, a blank
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

```yaml
name: chaos
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

## Configuration

Create `buttonmash.config.ts` (or `.js`/`.json`) — `buttonmash init` writes a
starter. CLI flags override the file.

```ts
import { defineConfig } from 'buttonmash';

export default defineConfig({
  target: 'https://staging.example.com',
  seed: 'ci',
  auth: { storageState: 'playwright/.auth/user.json' },

  budget: { maxActions: 500, maxDurationMs: 300_000, maxDepth: 12 },

  guardrails: {
    // allowedOrigins: ['https://staging.example.com'], // defaults to target origin
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
- **Blank screens** ("white screen of death") and **broken images**
- **Reflected input** — a safe canary probe that flags possible XSS sinks (never injects executing payloads)
- **Client-exposed secrets** (Stripe/AWS/GitHub/Slack/… keys, gitleaks-derived)
- **Accessibility** violations via axe-core (opt-in)
- **Custom signals** — your own console/DOM/url regex rules

Findings are **deduplicated** (the same bug firing 500× becomes one finding with
`count: 500`) and carry a minimal repro trace.

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
(for GitHub code-scanning). Exit codes follow the pytest/ESLint convention:

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
  → loop: discover interactive elements → fingerprint state (coverage)
          → run oracles → choose element (epsilon-greedy) → gate (safety)
          → perform action → log trace → capture artifacts on signal
  → aggregate + dedupe → report (json/junit/html/sarif) → exit code
```

## Limitations

- Doesn't pierce shadow DOM or cross-origin iframes (payment iframes are
  intentionally left alone).
- Pure random/coverage exploration can under-explore deep multi-step flows.
- Heuristic destructive detection is English-leaning + a few languages; extend
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

## License

[MIT](./LICENSE) © cj-vana
