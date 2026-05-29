import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: true,
  // Keep heavyweight runtime deps external; users get them from node_modules.
  external: ['playwright', 'playwright-core'],
  banner: {
    js: '',
  },
});
