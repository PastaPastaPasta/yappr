import { useLocalSearchParams } from 'expo-router';

import { ConnectionsScreen } from '~/features/profile/ConnectionsScreen';

/** Following of a profile (UX_SPEC §4.14). */
export default function FollowingScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <ConnectionsScreen id={id ?? ''} kind="following" />;
}
