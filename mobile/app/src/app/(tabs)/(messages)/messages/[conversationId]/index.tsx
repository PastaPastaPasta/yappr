import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function ConversationScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  return <Placeholder title="Conversation" detail={`conversationId: ${conversationId ?? ''}`} comingIn="the messages PR" />;
}
