// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'docs-private/**',
      'prototype/**',
      '.older-client/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.ts',
            'apps/*/vitest.config.ts',
            'apps/*/vitest.*.config.ts',
            'packages/*/vitest.config.ts',
          ],
          // One per package's vitest.config.ts, the root's, and the older
          // client's (5.2).
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Route handlers and small adapters are often `async` for their return
      // type alone; requiring an `await` inside them adds noise, not safety.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    // The service worker runs in its own global scope, not the browser's.
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
    rules: { 'no-useless-assignment': 'off' },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // The shared packages run everywhere: the API, the browser, and the
    // phone. Anything that exists on only one of them stays out, so a
    // package cannot quietly stop working on the others.
    files: ['packages/shared/src/**/*.ts', 'packages/client/src/**/*.ts'],
    ignores: ['**/*.test.ts', 'packages/client/src/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'react',
                'react-dom',
                'react-native',
                'react-native/*',
                'expo',
                'expo-*',
              ],
              message: 'Shared packages must run in the browser, on the phone and in Node alike.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
