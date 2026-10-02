import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

/** Report a post or reply (PRD SAFE-04), opened from its menu. Stub: the safety PR builds the sheet. */
export default function ReportScreen() {
  const { postId, kind } = useLocalSearchParams<{ postId?: string; kind?: string }>();
  return (
    <Placeholder
      title={kind === 'reply' ? 'Report reply' : 'Report post'}
      detail={`postId: ${postId ?? ''}`}
      comingIn="the safety PR"
    />
  );
}
