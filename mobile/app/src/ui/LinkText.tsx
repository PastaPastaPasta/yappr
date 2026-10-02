import { Pressable, type Insets, type StyleProp, type ViewStyle } from 'react-native';

import { cn } from '~/lib-allowlist';

import { Text } from './Text';
import { hitSlopFor, type TypeToken } from './tokens';

export interface LinkTextProps {
  label: string;
  onPress?: () => void;
  variant?: TypeToken;
  /** `link` for navigation, `button` for in-place actions ("Retry"). */
  role?: 'link' | 'button';
  className?: string;
  /** Overrides the default 44 pt padding, for links set close together (WriteStatus). */
  hitSlop?: Insets;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A standalone text action in `link` color ("Show more", "Check again",
 * "Vote on yap.pr"), underlined while pressed and padded to a 44 pt target.
 */
export function LinkText({
  label,
  onPress,
  variant = 'subhead',
  role = 'link',
  className,
  hitSlop = hitSlopFor(20),
  style,
  testID,
}: LinkTextProps) {
  return (
    <Pressable
      accessibilityRole={role}
      hitSlop={hitSlop}
      onPress={onPress}
      disabled={!onPress}
      testID={testID}
      className={cn('self-start', className)}
      style={style}
    >
      {({ pressed }) => (
        <Text variant={variant} tone="link" className={pressed ? 'underline' : undefined}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
