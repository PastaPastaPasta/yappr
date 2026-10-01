import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function HashtagScreen() {
  const { tag } = useLocalSearchParams<{ tag?: string }>();
  return <Placeholder title="Hashtag" detail={`tag: ${tag ?? ''}`} comingIn="the explore and search PR" />;
}
