/**
 * The only door from the app into the web's `lib/` (ADR-001 E2).
 *
 * A web module may be re-exported here only if it is pure, including
 * everything it imports: no SDK, no browser globals, no storage, no
 * `process.env`, and no dependency on `lib/constants` or
 * `lib/contract-topology`. Those read the web's build-time env, which Metro
 * does not inline, so they would silently fall back to testnet defaults.
 * Contract limits and capabilities come from the engine instead.
 *
 *   export { formatSomething } from '@/lib/some-pure-module';   // LIB_ALLOWLIST
 *   export type { Post } from '@/lib/types';                     // LIB_TYPE_ALLOWLIST
 *
 * Import them elsewhere as `~/lib-allowlist`. ESLint (`eslint.config.js`)
 * rejects `lib/` imports everywhere else, and anything not on the lists here.
 * Both lists and this file are append-only (mobile/CLAUDE.md).
 */
export {};
