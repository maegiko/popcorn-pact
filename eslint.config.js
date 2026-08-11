// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // Edge Functions are Deno, not the Expo app: different globals, different
    // module resolution. They are typechecked by `deno check`, not by tsc/eslint
    // here, which is also why tsconfig.json excludes them.
    ignores: ['dist/*', 'supabase/functions/*'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/array-type': ['error', { default: 'array' }],
      '@typescript-eslint/no-require-imports': 'error',
      'react/display-name': 'error',
    },
  },
]);
