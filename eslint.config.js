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
      '.claude/**',
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
  {
    // Every time the web app shows is on the family's clock (0.9.0, TZ):
    // a moment is turned into words through family-time.tsx alone, which
    // takes the family's zone and says it where the browser's differs. The
    // platform's date formatting anywhere else would quietly use the
    // browser's zone, so it is refused here — toLocaleString with a date or
    // a date's options (a number's is fine), toLocaleDateString,
    // toLocaleTimeString and Intl.DateTimeFormat. A date without a time goes
    // through family-time.tsx's dateOnlyWords, which never shifts it.
    // apps/web/src/date-format-guard.test.ts checks this block catches them.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    ignores: [
      'apps/web/src/family-time.tsx',
      'apps/web/src/**/*.test.ts',
      'apps/web/src/**/*.test.tsx',
      'apps/web/src/test-api.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          "CallExpression[callee.property.name='toLocaleDateString']",
          "CallExpression[callee.property.name='toLocaleTimeString']",
          "CallExpression[callee.property.name='toLocaleString'][callee.object.type='NewExpression'][callee.object.callee.name='Date']",
          "CallExpression[callee.property.name='toLocaleString'] > ObjectExpression > Property[key.name=/^(hour|minute|second|timeStyle|dateStyle|weekday|day|month|year|era|timeZone|timeZoneName|hour12|hourCycle|dayPeriod)$/]",
          "NewExpression[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
          "CallExpression[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
          // toLocaleString on anything with no arguments, or a locale alone (the
          // TZ review): a date's would be the browser's clock. A number is
          // said with Intl.NumberFormat.
          "CallExpression[callee.property.name='toLocaleString'][arguments.length=0]",
          "CallExpression[callee.property.name='toLocaleString'][arguments.length=1]",
        ].map((selector) => ({
          selector,
          message:
            'Say a moment through family-time.tsx (exactWords, endWords, dateTimeWords, dayWordsOf), on the family’s clock; a date without a time through dateOnlyWords; a number with Intl.NumberFormat.',
        })),
      ],
      // whenExactly and whenWords fall back to the browser's zone when given
      // none: the web asks them only through family-time.tsx, which always
      // gives the family's (the TZ review).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@fdv/shared',
              importNames: ['whenExactly', 'whenWords'],
              message:
                'Use exactWords or relativeWords from family-time.tsx: they say the moment on the family’s clock.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
