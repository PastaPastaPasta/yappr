import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function NewMessageScreen() {
  const { with: recipient } = useLocalSearchParams<{ with?: string }>();
  return <Placeholder title="New message" detail={`with: ${recipient ?? ''}`} comingIn="the messages PR" />;
}
