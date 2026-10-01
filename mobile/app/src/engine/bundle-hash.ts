import { config } from '~/config';

/**
 * Identifies the embedded engine bundle. It is part of the query-cache
 * buster, so data persisted by one engine build is never restored into
 * another (DTO shapes and contract topologies change between builds).
 */
export const ENGINE_BUNDLE_HASH = config.engine?.bundleHash ?? 'no-engine';
