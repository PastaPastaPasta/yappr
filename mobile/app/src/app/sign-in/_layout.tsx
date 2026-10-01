import { Stack } from 'expo-router';

import { stackScreenOptions } from '~/ui/stack-options';

/** The sign-in flow, presented as one modal over the app (see the root layout). */
export default function SignInLayout() {
  return <Stack screenOptions={stackScreenOptions} />;
}
