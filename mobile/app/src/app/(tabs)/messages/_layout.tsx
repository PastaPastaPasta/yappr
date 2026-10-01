import { Stack } from 'expo-router';

import { stackScreenOptions } from '~/ui/stack-options';

/** The Messages tab's own stack. New message / new group are root modals (src/app/messages/). */
export const unstable_settings = { anchor: 'index' };

export default function MessagesLayout() {
  return <Stack screenOptions={stackScreenOptions} />;
}
