import { useLocalSearchParams } from 'expo-router';

import { ProfileScreen } from '~/features/profile/ProfileScreen';
import { ComposeFab } from '~/ui/ComposeFab';

/** Anyone's profile, by identity id or DPNS name (UX_SPEC §4.12). */
export default function UserProfileScreen() {
  const { id, tab } = useLocalSearchParams<{ id?: string; tab?: string }>();
  return (
    <>
      <ProfileScreen idOrName={id ?? ''} requestedTab={tab} />
      <ComposeFab />
    </>
  );
}
