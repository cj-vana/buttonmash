import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Browser-driven e2e tests need room to launch Chromium and run a fuzz loop.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      // Measured under Vitest 4's AST-aware V8 remapping, which counts the
      // callbacks handed to page.evaluate (they run in the browser, never in
      // Node) as uncovered. Vitest 2's figures ran higher on the same tests.
      thresholds: {
        statements: 68,
        branches: 58,
        functions: 68,
        lines: 70,
        'src/capture/artifacts.ts': {
          statements: 95,
          branches: 95,
          functions: 100,
          lines: 95,
        },
        'src/baseline.ts': { statements: 90, branches: 80, functions: 100, lines: 90 },
        // Most of this file is page.evaluate callbacks (the rendered-content,
        // overlay and globals scans); the real-browser tests exercise them.
        'src/detectors/page-checks.ts': {
          statements: 50,
          branches: 40,
          functions: 30,
          lines: 50,
        },
        'src/explorer/frontier.ts': {
          statements: 90,
          branches: 85,
          functions: 100,
          lines: 90,
        },
        'src/explorer/readiness.ts': {
          statements: 90,
          branches: 80,
          functions: 100,
          lines: 90,
        },
        'src/explorer/run-result.ts': {
          statements: 90,
          branches: 85,
          functions: 100,
          lines: 90,
        },
        'src/report/github.ts': {
          statements: 85,
          branches: 55,
          functions: 100,
          lines: 85,
        },
        'src/report/sarif.ts': {
          statements: 90,
          branches: 80,
          functions: 100,
          lines: 90,
        },
      },
    },
  },
});
