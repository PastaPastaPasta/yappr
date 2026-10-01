/**
 * Type-checking only (tsconfig.json `paths`): what `@/components/*` resolves
 * to for TypeScript in the app.
 *
 * `type EngineApi` reaches web lib/ files, and two of them import a type
 * from a web component (`ProgressiveEnrichment` in lib/store.ts,
 * `PostingProgress` in lib/compose/publish-thread.ts). Following those would
 * type-check the web's React 18 component tree against the app's React 19
 * types. The app never sees either type, so they are opaque here. No
 * runtime code can import `@/components` (eslint/import-boundaries.js), so
 * Metro never resolves this mapping.
 */
export type ProgressiveEnrichment = Record<string, unknown>;
export type PostingProgress = Record<string, unknown>;
