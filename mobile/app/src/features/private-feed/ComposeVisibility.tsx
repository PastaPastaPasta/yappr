import type { PostDTO } from '@engine/api';
import { router } from 'expo-router';
import { Pressable, TextInput, View } from 'react-native';
import { ChevronDownIcon, GlobeAltIcon, LockClosedIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { useNativeText } from '~/ui/native-text';
import { PostCard } from '~/ui/post/PostCard';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

import { copy } from './copy';
import { usePrivateAccess } from './private-feed-data';
import { usePrivateBody } from './PrivatePostBody';

export type Visibility = 'public' | 'private' | 'private-with-teaser';

/** `components/compose/visibility-selector.tsx` `TEASER_LIMIT` (the engine refuses a longer one). */
export const TEASER_LIMIT = 280;

const VISIBILITIES: readonly Visibility[] = ['public', 'private', 'private-with-teaser'];

/** Whether the viewer has a private feed to post into (their own `privateFeed.access`). */
export function useOwnPrivateFeed(identityId: string, enabled: boolean): boolean | undefined {
  const { data } = usePrivateAccess(identityId, enabled);
  return data?.hasFeed;
}

/**
 * Who can see the post (web's visibility selector), as a chip that opens a
 * sheet. A private choice without a private feed offers to set one up
 * (Settings → Private feed) instead.
 */
export function VisibilityChip({
  value,
  onChange,
  hasFeed,
  disabled = false,
}: {
  value: Visibility;
  onChange: (value: Visibility) => void;
  /** undefined while it is being read. */
  hasFeed: boolean | undefined;
  disabled?: boolean;
}) {
  const c = useColors();
  const isPrivate = value !== 'public';
  const choose = () =>
    showActionSheet({
      title: copy.compose.label,
      actions: VISIBILITIES.map((option) => ({
        label: copy.compose.visibility[option],
        onPress: () => {
          if (option === 'public' || hasFeed) {
            onChange(option);
            return;
          }
          showActionSheet({
            title: `${copy.compose.setUpTitle}. ${copy.compose.setUpBody}`,
            actions: [{ label: copy.compose.setUp, onPress: () => router.push('/settings/private-feed') }],
          });
        },
      })),
    });
  const Icon = isPrivate ? LockClosedIcon : GlobeAltIcon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${copy.compose.label}: ${copy.compose.visibility[value]}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={choose}
      hitSlop={8}
      className={cn(
        'min-h-8 flex-row items-center gap-1 rounded-full border px-3',
        isPrivate ? 'border-purple-300 bg-purple-50 dark:border-purple-800 dark:bg-purple-950/30' : cn(tw.borderStrong, 'bg-transparent'),
        disabled && 'opacity-50',
      )}
      testID="compose-visibility"
    >
      <Icon size={14} color={isPrivate ? c.private : c.textSecondary} />
      <Text variant="captionStrong" tone={isPrivate ? 'private' : 'secondary'} maxFontSizeMultiplier={1.5}>
        {copy.compose.visibility[value]}
      </Text>
      <ChevronDownIcon size={12} color={isPrivate ? c.private : c.textSecondary} />
    </Pressable>
  );
}

/** The public teaser of a "private, with a public teaser" post; uncontrolled, so no keystroke is lost. */
export function TeaserField({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) {
  const c = useColors();
  const { key: inputKey, attach, inputProps } = useNativeText({ value, onChangeText });
  const over = Array.from(value).length > TEASER_LIMIT;
  return (
    <View className="mb-3 gap-1 pl-[60px] pr-4" testID="compose-teaser">
      <TextInput
        key={inputKey}
        ref={attach}
        {...inputProps}
        placeholder={copy.compose.teaserPlaceholder}
        placeholderTextColor={c.textPlaceholder}
        accessibilityLabel={copy.compose.teaserLabel}
        multiline
        className={cn('min-h-11 rounded-lg border px-3 py-2 text-base', over ? 'border-red-600 dark:border-red-400' : tw.borderStrong)}
        style={{ color: c.textPrimary }}
        testID="compose-teaser-input"
      />
      <Text variant="caption" tone={over ? 'error' : 'secondary'} className="text-right">
        {`${Array.from(value).length}/${TEASER_LIMIT}`}
      </Text>
    </View>
  );
}

/** A line under the editor about who will see it, in purple (private content, ADR E3). */
export function PrivateNote({ children, testID }: { children: string; testID?: string }) {
  const c = useColors();
  return (
    <View className="mb-3 flex-row items-start gap-1.5 pl-[60px] pr-4" testID={testID}>
      <LockClosedIcon size={14} color={c.private} style={{ marginTop: 2 }} />
      <Text variant="caption" tone="private" className="flex-1">
        {children}
      </Text>
    </View>
  );
}

/** The post replied to, as compose shows it: a private one decrypted for the viewer. */
export function ReplyTargetCard({ post }: { post: PostDTO }) {
  const privateCard = usePrivateBody(post);
  return <PostCard post={post} variant="compact" {...privateCard} />;
}
