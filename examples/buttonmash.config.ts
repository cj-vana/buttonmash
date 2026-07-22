import { defineConfig } from 'buttonmash';

/**
 * Example configuration. Copy to your project root as `buttonmash.config.ts`
 * and adjust. Run with: `buttonmash run` (or `npx buttonmash run`).
 */
export default defineConfig({
  target: 'http://localhost:3000',
  seed: 'ci',

  // Capture once with: buttonmash auth http://localhost:3000/login
  auth: { storageState: 'playwright/.auth/user.json' },

  budget: {
    maxActions: 500,
    maxDurationMs: 300_000,
  },

  guardrails: {
    // allowedOrigins: ['http://localhost:3000'], // defaults to target's origin
    billing: { mode: 'refuse' }, // refuse to run against LIVE payment keys
    // dryRun: true,              // read-only exploration
  },

  detectors: {
    // a11y: true,
    ignoreHttpStatuses: [401, 403],
    ignorePatterns: ['ResizeObserver loop', 'favicon'],
    custom: [
      {
        name: 'react-error-boundary',
        pattern: 'Error boundary',
        severity: 'high',
        target: 'console',
      },
    ],
  },

  failOn: 'high',
});
