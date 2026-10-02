import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

/** Block @x (PRD SAFE-01), opened from a post's menu. Stub: the safety PR builds the sheet. */
export default function BlockScreen() {
  const { userId } = useLocalSearchParams<{ userId?: string }>();
  return <Placeholder title="Block" detail={`userId: ${userId ?? ''}`} comingIn="the safety PR" />;
}
