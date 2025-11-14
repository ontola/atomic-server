import {
  defineConfig,
  globalIgnores,
} from 'eslint/config';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11Y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import js from "@eslint/js";
import globals from 'globals';

export default defineConfig([
  globalIgnores([
    // These files are generated so we can't fix the linting errors in them.
    'data-browser/src/locales/**',
  ]),
  {
    ...jsxA11Y.flatConfigs.recommended,
    rules: {
      ...jsxA11Y.flatConfigs.recommended.rules,
      'jsx-a11y/no-autofocus': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'],

    languageOptions: {
      parser: tsparser,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        React: true,
      },
    },

    plugins: {
      '@typescript-eslint': tseslint,
      js,
    },

    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { 'varsIgnorePattern': '^_', 'argsIgnorePattern': '^_', "caughtErrorsIgnorePattern": "^_|^e$" }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-shadow': 'off',
      "@typescript-eslint/no-shadow": ["error"],
      "@typescript-eslint/member-ordering": "error",
      'no-console': ['error', { allow: ['error', 'warn'] }],
      'class-methods-use-this': 'off',
      'semi': ['error', 'always'],
      'quotes': ['error', 'single'],
      'eqeqeq': ['error', 'always'],
      'padding-line-between-statements': [
        'error',
        {
          'blankLine': 'always',
          'next': 'return',
          'prev': '*'
        },
        {
          'blankLine': 'always',
          'next': 'export',
          'prev': '*'
        },
        {
          'blankLine': 'always',
          'next': 'multiline-block-like',
          'prev': '*'
        },
        {
          'blankLine': 'always',
          'next': '*',
          'prev': 'multiline-block-like'
        },
        {
          'blankLine': 'any',
          'next': 'export',
          'prev': 'export'
        }
      ],
      ...prettierConfig.rules,
    },
  },
  {
    ...react.configs.flat.recommended,
    rules: {
      ...react.configs.flat.recommended.rules,
      'react/prop-types': 'off',
      "react/no-unknown-property": ["error", { "ignore": ["about"] }],
    },
  },
  react.configs.flat['jsx-runtime'],
  {
    ...reactHooks.configs.flat['recommended-latest'],
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      ...reactHooks.configs.flat['recommended-latest'].rules,
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'off',
      // This rule is way to aggressive and seems to be designed for people that don't understand refs.
      'react-hooks/refs': 'off',
    }
  }
]);
