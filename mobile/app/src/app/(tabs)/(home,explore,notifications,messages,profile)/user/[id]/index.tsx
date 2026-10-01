import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function UserProfileScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <Placeholder title="Profile" detail={`id: ${id ?? ''}`} comingIn="the profiles PR" />;
}
