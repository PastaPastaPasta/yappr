import { useLocalSearchParams } from 'expo-router';

import { HashtagScreen } from '~/features/explore/HashtagScreen';

export default function HashtagRoute() {
  const { tag } = useLocalSearchParams<{ tag?: string }>();
  // A link to another tag reuses this screen: start it fresh (Latest, at the top).
  return <HashtagScreen key={tag ?? ''} tagParam={tag} />;
}
