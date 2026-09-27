import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'examples/buggy-app/**',
      // local agent settings and worktrees, not part of the project
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Code in these modules is serialized and executed in the browser page context,
    // so it legitimately references DOM globals and uses `any` for serialized shapes.
    files: ['src/explorer/discover.ts', 'src/detectors/**/*.ts', 'src/guardrails/billing.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
