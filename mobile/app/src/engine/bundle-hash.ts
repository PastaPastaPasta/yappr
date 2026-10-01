/**
 * Identifies the embedded engine bundle. It is part of the query-cache
 * buster, so data persisted by one engine build is never restored into
 * another (DTO shapes and contract topologies change between builds).
 *
 * TODO(engine host PR): replace with the content hash of the embedded bundle.
 */
export const ENGINE_BUNDLE_HASH = 'no-engine';
