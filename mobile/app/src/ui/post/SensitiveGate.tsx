import { useCallback, useReducer, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { EyeSlashIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';

import { Text } from '../Text';
import { colors, hitSlopFor } from '../tokens';

/**
 * Reveals last for the app session (web: until reload), so a card that
 * re-mounts (recycling, tab switches) stays open.
 */
const revealedThisSession = new Set<string>();

const VARIANTS = {
  card: { frame: 'min-h-8', icon: 16, text: 'text-xs', button: 'px-3 py-1' },
  embedded: { frame: 'min-h-7', icon: 14, text: 'text-[11px]', button: 'px-2.5 py-0.5' },
} as const;

/** A post's reveal state, shared by every card showing it this session. */
export function useSensitiveReveal(postId: string): [boolean, () => void] {
  // The set is the state; this only re-renders after a reveal. Reading by id
  // keeps a recycled cell from inheriting the previous post's reveal.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const reveal = useCallback(() => {
    revealedThisSession.add(postId);
    rerender();
  }, [postId]);
  return [revealedThisSession.has(postId), reveal];
}

export interface SensitiveGateProps {
  /** False: the gate is inert and renders its children. */
  active: boolean;
  revealed: boolean;
  onReveal: () => void;
  variant?: keyof typeof VARIANTS;
  children: ReactNode;
}

/**
 * The opaque NSFW cover (components/post/sensitive-content-gate.tsx). The
 * content is laid out underneath at full size, invisible and hidden from
 * screen readers, so revealing it never changes the card's height.
 */
export function SensitiveGate({
  active,
  revealed,
  onReveal,
  variant = 'card',
  children,
}: SensitiveGateProps) {
  if (!active) return <>{children}</>;

  const v = VARIANTS[variant];
  // One tree for both states: revealing only drops the cover, so nothing re-mounts or moves.
  return (
    <View className={cn('relative', v.frame)}>
      <View
        // Revealing changes this view's opacity and touch handling; without it the content would
        // also move to another native parent (mobile/CLAUDE.md, "Native view structure").
        collapsable={false}
        style={revealed ? undefined : { opacity: 0 }}
        importantForAccessibility={revealed ? 'auto' : 'no-hide-descendants'}
        accessibilityElementsHidden={!revealed}
        pointerEvents={revealed ? 'auto' : 'none'}
      >
        {children}
      </View>
      {revealed ? null : (
        <View
          testID="sensitive-gate"
          // Swallows taps, so the card under it doesn't open; only Show acts.
          onStartShouldSetResponder={() => true}
          className="absolute inset-0 flex-row items-center justify-center gap-2 overflow-hidden rounded-xl bg-gray-900 px-3 dark:border dark:border-gray-800 dark:bg-gray-950"
        >
          <EyeSlashIcon size={v.icon} color={colors.gray400} />
          <Text
            variant="caption"
            numberOfLines={1}
            className={cn('shrink', v.text)}
            style={{ color: colors.gray300 }}
          >
            <Text variant="caption" className={cn('font-medium', v.text)} style={{ color: colors.gray100 }}>
              NSFW
            </Text>
            {' · The author flagged this post'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show post flagged as NSFW"
            hitSlop={hitSlopFor(24)}
            testID="sensitive-show"
            onPress={onReveal}
            className={cn('shrink-0 rounded-full bg-gray-100 active:bg-white', v.button)}
          >
            <Text variant="buttonSm" style={{ color: colors.gray900 }}>
              Show
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
