import { useLocalSearchParams } from 'expo-router';

import { SearchResultsScreen } from '~/features/explore/SearchResultsScreen';

export default function SearchResultsRoute() {
  const { kind, q } = useLocalSearchParams<{ kind?: string; q?: string }>();
  return <SearchResultsScreen kind={kind} query={q ?? ''} />;
}
