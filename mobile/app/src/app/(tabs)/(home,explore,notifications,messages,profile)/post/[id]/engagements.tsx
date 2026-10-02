import { useLocalSearchParams } from 'expo-router';

import { EngagementsScreen } from '~/features/engagements/EngagementsScreen';

export default function EngagementsRoute() {
  const { id, kind, tab } = useLocalSearchParams<{ id: string; kind?: string; tab?: string }>();
  return <EngagementsScreen id={id ?? ''} kind={kind === 'reply' ? 'reply' : 'post'} requestedTab={tab} />;
}
