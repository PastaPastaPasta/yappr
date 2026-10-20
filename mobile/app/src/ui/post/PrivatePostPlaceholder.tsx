import type { ReactNode } from 'react';
import { View } from 'react-native';
import { LockClosedIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';

import { Text } from '../Text';
import { useColors } from '../tokens';

export interface PrivatePostPlaceholderProps {
  /** What the viewer should know about it, in place of "Only approved followers can see this." */
  message?: string;
  /** Below the message: what the viewer can do (request access, cancel, try again). */
  children?: ReactNode;
  /** The tighter version inside a quote embed. */
  compact?: boolean;
}

/**
 * A private-feed post the viewer can't read (UX_SPEC §5.3): "Private post",
 * why, and what they can do about it. Purple is reserved for private
 * content (ADR E3).
 */
export function PrivatePostPlaceholder({ message, children, compact = false }: PrivatePostPlaceholderProps) {
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
          {message ?? 'Only approved followers can see this.'}
        </Text>
      )}
      {compact ? null : children}
    </View>
  );
}
