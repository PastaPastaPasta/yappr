import { useNetInfo } from '@react-native-community/netinfo';
import { View } from 'react-native';
import { SignalSlashIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

/** UX_SPEC §2.18: under the navigation bar while the OS reports no connectivity (PRD G-1). */
export function OfflineBanner() {
  const c = useColors();
  const { isConnected } = useNetInfo();
  if (isConnected !== false) return null;
  return (
    <View
      accessibilityRole="alert"
      testID="offline-banner"
      className={cn('min-h-9 flex-row items-center gap-2 px-4 py-2', tw.offlineBg)}
    >
      <SignalSlashIcon size={16} color={c.textPrimary} />
      <Text variant="subhead">You&apos;re offline. Showing saved posts.</Text>
    </View>
  );
}
