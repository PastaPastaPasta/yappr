import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useViewerId } from '~/data/session';

/** The signed-in identity's profile (name, avatar, usernames), shared with the profile screens' cache. */
export function useViewerProfile() {
  const viewerId = useViewerId() ?? '';
  return useEngineQuery(queryKeys.profile.detail(viewerId), (api) => api.profiles.get(viewerId), {
    enabled: viewerId !== '',
    persist: true,
  });
}
