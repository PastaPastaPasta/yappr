import { View } from 'react-native';
import { LockClosedIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';

import { LinkText } from '../LinkText';
import { Text } from '../Text';
import { useColors } from '../tokens';

export interface PrivatePostPlaceholderProps {
  onOpenWeb?: () => void;
  /** The tighter version inside a quote embed. */
  compact?: boolean;
}

/**
 * Stands in for an encrypted private-feed post (UX_SPEC §5.3): who can read
 * it, and "Open on yap.pr", where approved followers read it (private feeds
 * aren't in 1.0). Purple is reserved for private content (ADR E3).
 */
export function PrivatePostPlaceholder({ onOpenWeb, compact = false }: PrivatePostPlaceholderProps) {
  const c = useColors();
  return (
    <View
      testID="private-post"
      className={cn(
        'mt-1 gap-1 rounded-xl border border-purple-200 bg-purple-50 p-3 dark:border-purple-900 dark:bg-purple-950/30',
        compact && 'p-2',
      )}
    >
      <View className="flex-row items-center gap-1.5">
        <LockClosedIcon size={compact ? 14 : 16} color={c.private} />
        <Text variant="subheadStrong" tone="private">
          Private post
        </Text>
      </View>
      {compact ? null : (
        <Text variant="subhead" tone="secondary">
          Only approved followers can see this.
        </Text>
      )}
      {onOpenWeb && !compact ? (
        <LinkText label="Open on yap.pr" variant="subheadStrong" onPress={onOpenWeb} />
      ) : null}
    </View>
  );
}
