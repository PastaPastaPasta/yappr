/**
 * Type-checking only (tsconfig.json `paths`): what `@/components/*` resolves
 * to for TypeScript in the app.
 *
 * `type EngineApi` reaches web lib/ files, and two of them import a type
 * from a web component (`ProgressiveEnrichment` in lib/store.ts,
 * `PostingProgress` in lib/compose/publish-thread.ts). Following those would
 * type-check the web's React 18 component tree against the app's React 19
 * types. ProgressiveEnrichment stays opaque (the app never sees it);
 * PostingProgress is copied, since engine code reads its fields. No
 * runtime code can import `@/components` (eslint/import-boundaries.js), so
 * Metro never resolves this mapping.
 */
export type ProgressiveEnrichment = Record<string, unknown>;
/** Mirrors components/compose/compose-sub-components.tsx: the engine's publish path reads its fields. */
export interface PostingProgress {
  current: number;
  total: number;
  status: string;
}
