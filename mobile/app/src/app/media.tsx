import { useLocalSearchParams } from 'expo-router';

import { MediaViewer } from '~/features/media-viewer/MediaViewer';

export default function MediaViewerScreen() {
  const { postId, index } = useLocalSearchParams<{ postId?: string; index?: string }>();
  const start = Number.parseInt(index ?? '0', 10);
  return <MediaViewer postId={postId ?? ''} initialIndex={Number.isFinite(start) ? start : 0} />;
}
