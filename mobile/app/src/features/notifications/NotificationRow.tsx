import { memo } from 'react';
import { Pressable, View } from 'react-native';
import {
  ArrowPathRoundedSquareIcon,
  AtSymbolIcon,
  BellIcon,
  BookOpenIcon,
  ChatBubbleBottomCenterTextIcon,
  ChatBubbleLeftIcon,
  HeartIcon,
  LockClosedIcon,
  LockOpenIcon,
  ShieldExclamationIcon,
  UserPlusIcon,
} from 'react-native-heroicons/outline';

import { cn, formatTime } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { RelativeTime } from '~/ui/RelativeTime';
import { Text } from '~/ui/Text';
import { useRipple } from '~/ui/ripple';
import { colors, tw, type IconComponent } from '~/ui/tokens';

import { phraseOf, type NotificationRowModel, type NotificationType } from './notification-model';

/**
 * Type icons and their decorative colors (UX_SPEC §1.2: the phrase carries
 * the meaning). Tailwind's 500s, as on web: purple, yellow, red, green, blue.
 */
const YELLOW_500 = '#eab308';
const BLUE_500 = '#3b82f6';
const ICONS: Record<NotificationType, { Icon: IconComponent; color: string }> = {
  follow: { Icon: UserPlusIcon, color: colors.purple500 },
  mention: { Icon: AtSymbolIcon, color: YELLOW_500 },
  like: { Icon: HeartIcon, color: colors.red500 },
  repost: { Icon: ArrowPathRoundedSquareIcon, color: colors.green500 },
  quote: { Icon: ChatBubbleBottomCenterTextIcon, color: colors.green500 },
  reply: { Icon: ChatBubbleLeftIcon, color: BLUE_500 },
  blogPost: { Icon: BookOpenIcon, color: colors.yappr500 },
  blogComment: { Icon: ChatBubbleLeftIcon, color: colors.yappr500 },
  privateFeedRequest: { Icon: LockClosedIcon, color: BLUE_500 },
  privateFeedApproved: { Icon: LockOpenIcon, color: colors.green500 },
  privateFeedRevoked: { Icon: ShieldExclamationIcon, color: colors.red500 },
};
const FALLBACK_ICON = { Icon: BellIcon, color: colors.gray500 };

/** Grouped likes show up to this many faces. */
const STACK = 3;

export interface NotificationRowProps {
  row: NotificationRowModel;
  /** The two-line post snippet, already gated (`snippetOf`). */
  snippet: string | null;
  onPress: (row: NotificationRowModel) => void;
  onActorPress: (actorId: string) => void;
}

function Actors({ row }: { row: NotificationRowModel }) {
  if (row.actors.length === 1) {
    const actor = row.actors[0];
    return <Avatar avatar={actor.avatar} identityId={actor.id} size="md" />;
  }
  // Stacked faces, newest in front (UX_SPEC §2.3 `xs`).
  return (
    <View className="h-10 w-10 flex-row items-center" testID="stacked-avatars">
      {row.actors.slice(0, STACK).map((actor, index) => (
        <View
          key={actor.id}
          className={cn('rounded-full border-2 border-white dark:border-neutral-900', index > 0 && '-ml-3')}
          style={{ zIndex: STACK - index }}
        >
          <Avatar avatar={actor.avatar} identityId={actor.id} size="xs" />
        </View>
      ))}
    </View>
  );
}

/**
 * One notification (UX_SPEC §4.18): the type icon, the actor's avatar (or
 * stacked avatars for grouped likes), "**Alice** liked your post", the
 * post's snippet and the time. Unread rows are tinted with a dot at the
 * leading edge. The row is one screen-reader element; opening the actor's
 * profile is its custom action.
 */
export const NotificationRow = memo(function NotificationRow({
  row,
  snippet,
  onPress,
  onActorPress,
}: NotificationRowProps) {
  const unread = row.unreadIds.length > 0;
  const actor = row.actors[0];
  const actorId = actor?.id ?? '';
  const name = actor?.displayName || 'Unknown User';
  const phrase = phraseOf(row);
  const { Icon, color } = ICONS[row.type] ?? FALLBACK_ICON;
  const label = [
    unread ? 'Unread.' : null,
    `${name} ${phrase}.`,
    snippet ? `${snippet}.` : null,
    row.noticed ? `Noticed ${formatTime(row.at)}` : formatTime(row.at),
  ]
    .filter(Boolean)
    .join(' ');

  const ripple = useRipple();
  return (
    <Pressable
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityActions={actorId ? [{ name: 'profile', label: `Open ${name}'s profile` }] : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'profile') onActorPress(actorId);
      }}
      onPress={() => onPress(row)}
      testID={`notification-${row.key}`}
      className={cn('flex-row border-b py-3 pr-4', tw.border, unread ? tw.bgUnread : null, tw.pressed)}
    >
      <View className="w-14 items-center pt-2.5">
        {unread ? (
          <View className="absolute left-1.5 top-[18px] h-2 w-2 rounded-full bg-yappr-500" testID="unread-dot" />
        ) : null}
        <Icon size={20} color={color} />
      </View>
      <View className="flex-1 gap-2">
        <View className="flex-row items-center gap-3">
          <Pressable
            onPress={() => onActorPress(actorId)}
            disabled={!actorId}
            accessible={false}
            hitSlop={4}
            className="active:opacity-80"
            testID={`notification-actor-${row.key}`}
          >
            <Actors row={row} />
          </Pressable>
          <View className="flex-1">
            <Text variant="subhead" numberOfLines={3}>
              <Text variant="subheadStrong" tone="emphasis">
                {name}
              </Text>{' '}
              {phrase}
            </Text>
            <RelativeTime
              date={row.at}
              prefix={row.noticed ? 'Noticed ' : undefined}
              variant="caption"
              tone="secondary"
              className="mt-0.5"
            />
          </View>
        </View>
        {snippet ? (
          <View className={cn('rounded-lg px-3 py-2.5', tw.bgMuted)}>
            <Text
              variant="subhead"
              tone="secondary"
              numberOfLines={2}
              className={snippet === 'NSFW content' ? 'italic' : undefined}
            >
              {snippet}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});
