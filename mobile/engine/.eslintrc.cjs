/**
 * Engine lint config. `root: true`: the repo root config ignores `mobile/**`
 * and is Next.js-specific; this one keeps the root's TypeScript rules.
 */
module.exports = {
  root: true,
  env: { es2022: true, browser: true, node: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  extends: ['eslint:recommended'],
  ignorePatterns: ['dist/', 'node_modules/', 'test-results/'],
  overrides: [
    {
      files: ['**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname },
      plugins: ['@typescript-eslint'],
      extends: ['plugin:@typescript-eslint/recommended'],
      rules: {
        // TypeScript already resolves globals; the core rule misfires on types.
        'no-undef': 'off',
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
        '@typescript-eslint/prefer-optional-chain': 'error',
      },
    },
    {
      // The engine reports through the bridge, not the console. entry.webview.ts is
      // excluded because it is the console forwarder (cf. lib/logger.ts in the root config).
      files: ['src/**/*.ts'],
      excludedFiles: ['src/entry.webview.ts'],
      rules: { 'no-console': 'error' },
    },
  ],
}
