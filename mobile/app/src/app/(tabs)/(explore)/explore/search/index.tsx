import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function SearchScreen() {
  const { q } = useLocalSearchParams<{ q?: string }>();
  return <Placeholder title="Search" detail={`q: ${q ?? ''}`} comingIn="the explore and search PR" />;
}
