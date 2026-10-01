import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function FollowersScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <Placeholder title="Followers" detail={`id: ${id ?? ''}`} comingIn="the profiles PR" />;
}
