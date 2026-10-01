import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function FollowingScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <Placeholder title="Following" detail={`id: ${id ?? ''}`} comingIn="the profiles PR" />;
}
