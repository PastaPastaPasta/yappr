import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <Placeholder title="Post" detail={`id: ${id ?? ''}`} comingIn="the post detail PR" />;
}
