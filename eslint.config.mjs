// Minimal lint guard.
//
// Primary purpose: catch `no-undef` ("X is not defined") — the exact class of bug
// that an unfinished refactor introduces silently. When imports are renamed
// (e.g. `evaluate` -> `_evaluate` behind a `_resolve(_deps)` helper) but a few
// call sites are missed, the code parses fine and only throws at runtime.
// `no-undef` flags those statically, so CI blocks the regression at PR time.
//
// Globals below are the runtime APIs used across src/ (Node + browser/CDP context).
export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly',
        process: 'readonly', Buffer: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', WebSocket: 'readonly', AbortController: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', global: 'readonly',
        __dirname: 'readonly', structuredClone: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
];
