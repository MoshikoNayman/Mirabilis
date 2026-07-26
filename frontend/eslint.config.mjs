// frontend/eslint.config.mjs
//
// Minimal flat config aimed at one real problem: 68 hand-written hook
// dependency arrays with nothing checking them, in a file that already carries
// eslint-disable comments implying a linter that was never actually wired up.
//
// react-hooks/exhaustive-deps starts as a WARNING on purpose. The existing
// backlog is large and mostly benign, and turning it straight to an error would
// mean either a mass edit with no test coverage behind it or a wall of new
// disable comments. rules-of-hooks stays an ERROR, because a violation there is
// always a real bug.

import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'tests/**', 'playwright-report/**']
  },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      // Browser globals come from the `globals` package rather than a
      // hand-written list, which was missing URLSearchParams, HTMLElement,
      // DOMException and others and reported them as undefined-variable errors.
      globals: {
        ...globals.browser,
        ...globals.node
            }
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      'no-undef': 'error'
    }
  }
];
