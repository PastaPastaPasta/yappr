import { Stack } from 'expo-router';
import { View } from 'react-native';

import { lastIdentity, useSession } from '~/data/session';
import { SignedOutPlaceholder } from '~/features/auth/SignedOutPlaceholder';
import { ProfileScreen } from '~/features/profile/ProfileScreen';
import { ComposeFab } from '~/ui/ComposeFab';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';

/** The Profile tab: the viewer's own profile (UX_SPEC §4.12), or the signed-out placeholder (§4.37). */
export default function OwnProfileScreen() {
  const { status, identityId } = useSession();
  if (status === 'signed-out') return <SignedOutPlaceholder kind="profile" screenTitle="Profile" />;
  // While the engine restores the session, whoever was signed in last time (PRD G-2).
  const id = identityId ?? lastIdentity();
  if (!id) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Profile' }} />
        <View className="flex-1 items-center justify-center">
          <Spinner />
        </View>
      </Screen>
    );
  }
  return (
    <>
      {/* Keyed: another account starts fresh (its tab, scroll and username card). */}
      <ProfileScreen key={id} idOrName={id} ownTab />
      <ComposeFab />
    </>
  );
}
