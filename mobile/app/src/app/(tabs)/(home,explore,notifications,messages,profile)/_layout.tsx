import { Stack } from 'expo-router';

import { stackScreenOptions } from '~/ui/stack-options';

/**
 * One stack per tab (UX_SPEC §3.1/§3.2). This array group expands into the
 * (home), (explore), (notifications), (messages) and (profile) groups, so the
 * shared detail routes in this folder (post, user, hashtag, ...) are pushed onto
 * whichever tab the user is in, and Back returns to where they came from (a
 * profile opened from a conversation goes back to the conversation). Each tab's
 * own screens live in its single-name group folder, e.g. `(explore)/explore/`.
 *
 * Settings screens another tab also opens (settings/notifications from the
 * Notifications gear, settings/messages from the inbox gear) live here too:
 * pushing a route that only one tab has switches to that tab instead.
 *
 * The launch link has no current tab; +native-intent pins it to (home), or
 * to (profile) for settings/notifications and settings/messages (pinColdRoute
 * in deep-links.ts).
 */
export const unstable_settings = {
  anchor: 'index',
  explore: { anchor: 'explore/index' },
  notifications: { anchor: 'notifications' },
  messages: { anchor: 'messages/index' },
  profile: { anchor: 'profile' },
};

export default function TabStackLayout() {
  return <Stack screenOptions={stackScreenOptions} />;
}
