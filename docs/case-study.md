# Field test: buttonmash vs. three popular open-source web apps

What actually happens when you point a chaos monkey at real, well-maintained
apps? We ran buttonmash 0.2.0 against local production builds of three
open-source projects and kept everything: the seed, the configs, and the full
reports.

The short version: one real robustness gap found (Excalidraw's clipboard
handling), one app passed clean (JSON Crack), one example build ships a
persistent 404 (TodoMVC), and the first run on every app needed about two
minutes of tuning to separate app bugs from sandbox noise. That first-run noise
is exactly what the
[baseline workflow](https://github.com/cj-vana/buttonmash#adopting-on-an-app-that-already-has-bugs)
exists for.

| App | Build tested | First run | After tuning |
| --- | --- | --- | --- |
| [TodoMVC React](https://github.com/tastejs/todomvc) (`ff43b02`) | committed production `dist/` | ✓ passed, 6 findings below threshold | not needed |
| [Excalidraw](https://github.com/excalidraw/excalidraw) (`f179f7f`) | `yarn build` | ✗ failed, 2 high | ✗ failed, 1 high (a real bug) |
| [JSON Crack](https://github.com/AykutSarac/jsoncrack.com) (`3c9af69`) | `next build` static export | ✗ failed, 5 high | ✓ passed, 16 low |

## Method

- buttonmash v0.2.0, Chromium, seed `casestudy`, budgets of 300 to 400 actions
  and 90 to 120 seconds per run. Every run replays from its seed.
- Production builds, served locally. Nothing was run against anyone's hosted
  service, and no external backend was touched: the origin fence blocks
  off-origin traffic by default.
- Default config except where shown; trace capture off to keep reports small.

## TodoMVC React: passed, with one persistent 404

208 actions across 4 pages (the `#/active` and `#/completed` hash routes count)
in 36 seconds. Verdict: passed, nothing at or above the `high` threshold.

The one real finding: the example fetches `/learn.json` on every load and it
does not exist in the standalone `dist/`, so the run logged the same 404 **65
times**, deduplicated into a single medium finding. Harmless in production
(todomvc.com serves the file), but the packaged example genuinely requests a
missing resource.

The other five findings were the origin fence doing its job: 65 attempted
navigations through footer links (todomvc.com, GitHub) were blocked and
recovered, logged as low-severity guardrail notes.

[Full report →](https://cj-vana.github.io/buttonmash/case-study/todomvc/report.html)

## Excalidraw: one real finding survives the tuning

The naive run failed with 2 high findings, but one of them was our sandbox, not
Excalidraw: the app kept retrying its collab WebSocket
(`oss-collab.excalidraw.com`), which the fence blocks, and logged a
`console.error` each time (16 of them, deduplicated to one finding). Two ignore
patterns make the sandbox noise disappear:

```json
{
  "detectors": {
    "ignorePatterns": ["oss-collab\\.excalidraw\\.com", "ERR_BLOCKED_BY_CLIENT"]
  }
}
```

The tuned run still fails, and the finding that survives looks like a real
robustness gap:

> `console.error: NotAllowedError: Failed to execute 'writeText' on
> 'Clipboard': Write permission denied.`

The monkey clicked a copy control in a context where clipboard write is denied,
and the rejection surfaced unhandled instead of degrading gracefully. Users
with clipboard permissions blocked hit the same path. It reproduces at the same
step on every replay of seed `casestudy`.

Two more things worth knowing about canvas-heavy apps:

- The destructive-verb guardrail refused to click "Reset zoom" three times
  ("reset" is on the verb list). Conservative, and tunable if you disagree.
- About two dozen clicks timed out on canvas-overlay elements and were logged
  as low-severity driver errors. Each timeout burns its 4-second budget, which
  is why the run managed only ~40 actions in 120 seconds. Canvas UIs are
  slower to mash than DOM UIs.

[Full report →](https://cj-vana.github.io/buttonmash/case-study/excalidraw/report.html)

## JSON Crack: clean after the same two-line tune

The naive run failed with 5 high findings, every one of them a
`console.error: Failed to load resource: net::ERR_BLOCKED_BY_CLIENT` from the
fence blocking the app's off-origin calls. Same `ignorePatterns` fix as above.

The tuned run passed: 110 actions in the naive pass and 59 in the tuned pass,
crawling 6 pages (`/`, `/editor`, `/docs`, the legal pages) and 23 distinct UI
states, with the form completer creating one record along the way. Everything
left was low-severity tool bookkeeping. The production export genuinely holds
up under a hundred-plus random interactions, and now there's a report proving
it.

[Full report →](https://cj-vana.github.io/buttonmash/case-study/jsoncrack/report.html)

## What we took away

1. **First runs are noisy in a predictable way.** A fenced sandbox blocks the
   app's external calls, and the app complains to the console about it. Two
   lines of `ignorePatterns`, or a saved baseline with `--fail-on-new`, gets
   you from noise to signal in minutes.
2. **Real findings replay.** The Excalidraw clipboard error is not a flake; the
   same seed produces the same click at the same step every time.
3. **Passing means something.** JSON Crack passing is evidence the export
   tolerates sustained random abuse, not an absence of testing.
4. **The guardrails earn their keep.** Across five runs the fence recovered
   dozens of attempted off-origin escapes and the verb list kept the monkey off
   anything labeled destructive, on apps it had never seen.

Findings that look like app bugs will be reported upstream to the respective
projects.
