import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function ConversationInfoScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  return <Placeholder title="Conversation info" detail={`conversationId: ${conversationId ?? ''}`} comingIn="the messages PR" />;
}
