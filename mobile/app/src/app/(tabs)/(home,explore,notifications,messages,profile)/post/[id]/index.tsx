import { useLocalSearchParams } from 'expo-router';

import { ThreadScreen } from '~/features/thread/ThreadScreen';

export default function PostScreen() {
  const { id, reply } = useLocalSearchParams<{ id: string; reply?: string }>();
  return <ThreadScreen id={id ?? ''} highlightId={reply || undefined} />;
}
