import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function MediaViewerScreen() {
  const { postId } = useLocalSearchParams<{ postId?: string }>();
  return <Placeholder title="Media" detail={`postId: ${postId ?? ''}`} comingIn="the post detail PR" />;
}
