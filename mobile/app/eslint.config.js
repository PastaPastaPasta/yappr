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

/**
 * mobile/engine/src modules the app may import at run time; everything else
 * from @engine is types only. These are the wire protocol, the codec and the
 * RPC client, which the host must share with the engine exactly. They stay
 * dependency-free (they import only each other: no packages, no lib/), which
 * src/__tests__/engine-runtime-imports.test.ts enforces. A trailing `/`
 * allows a directory.
 */
const ENGINE_RUNTIME_ALLOWLIST = ['protocol/', 'rpc/client', 'rpc/transport'];

const boundaryOptions = {
  libAllowlist: LIB_ALLOWLIST,
  libTypeAllowlist: LIB_TYPE_ALLOWLIST,
  allowlistFile: 'src/lib-allowlist.ts',
  engineRuntimeAllowlist: ENGINE_RUNTIME_ALLOWLIST,
};

/** Node-side tooling, which legitimately reads the web's config files. */
const TOOLING = [
  'app.config.ts',
  'plugins/**',
  'babel.config.js',
  'eslint.config.js',
  'eslint/**',
  'jest.config.js',
  'jest.setup.js',
  'metro.config.js',
  'tailwind.config.js',
];
const TESTS = ['**/*.test.{js,jsx,ts,tsx}', 'src/__tests__/**'];

const config = defineConfig([
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

module.exports = config;
module.exports.ENGINE_RUNTIME_ALLOWLIST = ENGINE_RUNTIME_ALLOWLIST;
