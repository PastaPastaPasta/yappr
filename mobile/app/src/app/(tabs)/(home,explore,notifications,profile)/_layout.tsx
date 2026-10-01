import { Stack } from 'expo-router';

import { stackScreenOptions } from '~/ui/stack-options';

/**
 * One stack per tab (UX_SPEC §3.1/§3.2). This array group expands into the
 * (home), (explore), (notifications) and (profile) groups, so the shared detail
 * routes in this folder (post, user, hashtag, ...) are pushed onto whichever
 * tab the user is in, and Back returns to where they came from. Each tab's own
 * screens live in its single-name group folder, e.g. `(explore)/explore/`.
 *
 * Cold links have no current tab; +native-intent pins them to (home).
 */
export const unstable_settings = {
  anchor: 'index',
  explore: { anchor: 'explore/index' },
  notifications: { anchor: 'notifications' },
  profile: { anchor: 'profile' },
};

export default function TabStackLayout() {
  return <Stack screenOptions={stackScreenOptions} />;
}
