import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ESLint flat configuration.
 *
 * This exists because `npm run lint` was listed in every package's scripts while
 * having no config file to run against. A script that is wired up but cannot
 * execute is worse than no script: it reads as coverage that does not exist.
 *
 * The type-aware ruleset is deliberately not enabled. Enabling
 * `recommendedTypeChecked` on a codebase whose types are already checked by
 * `tsc --strict` mostly produces rules that argue with the compiler about
 * things the compiler is better at, and the slow startup cost buys little. The
 * stylistic and correctness rules below are the ones that catch real defects.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/data/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused code is dead code. These three are errors rather than warnings
      // because an unused binding in a payments runtime is almost always a
      // half-finished refactor.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',

      // A floating promise in this codebase means a purchase may have been
      // initiated without its outcome being recorded or handled.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/await-thenable': 'off',

      // Correctness rules that matter more here than elsewhere.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-return-await': 'error',
      'require-await': 'error',
    },
  },

  {
    // The dashboard is a browser bundle and legitimately logs to the console.
    files: ['apps/dashboard/src/**/*.{ts,tsx}'],
    rules: { 'no-console': 'off' },
  },

  {
    /**
     * `require-await` is disabled where an interface, not a bug, forces async.
     *
     * `PaymentProvider` declares every method as returning a Promise, so the
     * fixture implementation must return one even though it resolves in memory
     * and has nothing to await. Same for Fastify route handlers, which accept a
     * plain return value but read as async throughout the file. Removing `async`
     * from half of them and not the other half would make the route table harder
     * to read, not easier.
     */
    files: [
      'packages/provider/src/mock/**/*.ts',
      'packages/server/src/server.ts',
    ],
    rules: { 'require-await': 'off' },
  },

  {
    // Tests assert on shape and reach into fixtures; the strictness that helps
    // in src gets in the way of readable assertions.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
