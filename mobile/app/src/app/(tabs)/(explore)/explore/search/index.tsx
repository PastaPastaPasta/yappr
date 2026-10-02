import { useLocalSearchParams } from 'expo-router';

import { SearchScreen } from '~/features/explore/SearchScreen';

export default function SearchRoute() {
  const { q } = useLocalSearchParams<{ q?: string }>();
  // A link with another query, while search is open, starts that search.
  return <SearchScreen key={q ?? ''} initialQuery={q ?? ''} />;
}
