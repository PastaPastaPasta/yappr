import type { SettingsDTO } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';

export type NsfwMode = SettingsDTO['sensitiveContentMode'];

export interface ContentSettings {
  /** `blur` ("Warn first"), `show` or `hide` (PRD SAFE-06). */
  nsfwMode: NsfwMode;
  /** Hold back media from authors the viewer doesn't follow (PRD SAFE-07). */
  gateMedia: boolean;
}

/** Web's defaults, used until the engine answers: nothing flagged or unfollowed shows before it does. */
export const DEFAULT_CONTENT_SETTINGS: ContentSettings = { nsfwMode: 'blur', gateMedia: true };

/**
 * The content gates' settings (`settings.get`), device-wide. The Privacy &
 * Safety screen writes them through `settings.set` and the same query key,
 * so every card follows a change at once. Persisted, so cards paint gated
 * correctly before the engine boots.
 */
export function useContentSettings(): ContentSettings {
  const { data } = useEngineQuery(queryKeys.settings, (api) => api.settings.get(), {
    persist: true,
    // Only this app changes them, through the same key: no need to re-read on every card mount.
    staleTime: 5 * 60_000,
  });
  if (!data) return DEFAULT_CONTENT_SETTINGS;
  return { nsfwMode: data.sensitiveContentMode, gateMedia: data.gateMediaFromNonFollowed };
}
