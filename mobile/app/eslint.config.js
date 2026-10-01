// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

const boundaries = require('./eslint/import-boundaries');

/**
 * Web lib/ modules the app may import, through src/lib-allowlist.ts only
 * (ADR-001 E2). A module qualifies only if it is pure, transitively: no SDK,
 * no browser globals, no storage, no `process.env`, and no dependency on
 * lib/constants or lib/contract-topology (limits and capabilities come from
 * the engine). Append-only; see mobile/CLAUDE.md.
 */
const LIB_ALLOWLIST = [];
/** Allowed for `import type` / `export type` only (erased at build time). */
const LIB_TYPE_ALLOWLIST = ['lib/types'];

const boundaryOptions = {
  libAllowlist: LIB_ALLOWLIST,
  libTypeAllowlist: LIB_TYPE_ALLOWLIST,
  allowlistFile: 'src/lib-allowlist.ts',
};

/** Node-side tooling, which legitimately reads the web's config files. */
const TOOLING = [
  'app.config.ts',
  'babel.config.js',
  'eslint.config.js',
  'eslint/**',
  'jest.config.js',
  'jest.setup.js',
  'metro.config.js',
  'tailwind.config.js',
];
const TESTS = ['**/*.test.{js,jsx,ts,tsx}', 'src/__tests__/**'];

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'ios/*', 'android/*', '.expo/*'],
  },
  {
    files: TOOLING,
    languageOptions: { globals: { ...globals.node, jest: 'readonly' } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Static asset requires are how React Native loads images and fonts.
      '@typescript-eslint/no-require-imports': [
        'warn',
        { allow: ['\\.(png|jpe?g|gif|webp|svg|ttf|otf|mp4|json)$'] },
      ],
    },
  },
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    ignores: [...TOOLING, ...TESTS],
    plugins: { yappr: boundaries },
    rules: { 'yappr/import-boundaries': ['error', boundaryOptions] },
  },
  {
    // Tests may read repo files (the web's tailwind config), but still never the SDK or the engine.
    files: TESTS,
    plugins: { yappr: boundaries },
    rules: { 'yappr/import-boundaries': ['error', { ...boundaryOptions, allowRepoFiles: true }] },
  },
]);
