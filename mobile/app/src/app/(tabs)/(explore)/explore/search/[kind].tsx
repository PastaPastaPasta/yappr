import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function SearchResultsScreen() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  return <Placeholder title="Search results" detail={`kind: ${kind ?? ''}`} comingIn="the explore and search PR" />;
}
