import { cn } from '~/lib-allowlist';

import { tw } from '../tokens';

/** The bordered box quotes, polls, stubs and previews sit in (`radius.xl`, `border.strong`). */
export const EMBED_FRAME = cn('mt-3 rounded-xl border', tw.borderStrong);
