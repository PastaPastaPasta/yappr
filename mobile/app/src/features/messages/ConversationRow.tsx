import type { ConversationDTO } from '@engine/api';
import { memo } from 'react';
import { Pressable, View } from 'react-native';

import { cn } from '~/lib-allowlist';
import { UnreadDot } from '~/ui/Badge';
import { RelativeTime } from '~/ui/RelativeTime';
import { Text } from '~/ui/Text';
import { useRipple } from '~/ui/ripple';
import { tw } from '~/ui/tokens';
import { useRelativeTime } from '~/ui/use-relative-time';

import { ConversationAvatar } from './ConversationAvatar';
import { conversationTitle, memberCount, previewText } from './dm-model';

export interface ConversationRowProps {
  conversation: ConversationDTO;
  onPress: (conversation: ConversationDTO) => void;
  onLongPress?: (conversation: ConversationDTO) => void;
}

/**
 * An inbox row (UX_SPEC §4.19): avatar 40, name (`body.strong`), time,
 * a one-line preview and the unread dot. Unread rows set name and preview
 * in `text.primary` weight 600; read previews are `text.secondary`.
 */
export const ConversationRow = memo(function ConversationRow({ conversation, onPress, onLongPress }: ConversationRowProps) {
  const title = conversationTitle(conversation);
  const preview = previewText(conversation);
  const unread = conversation.unread > 0;
  // The last message's own time (my send shows when I sent it); the order stays by last activity.
  const time = conversation.lastMessage?.at ?? conversation.lastActivity;
  const at = time ? new Date(time) : null;
  const group = conversation.kind === 'group';
  const spokenTime = useRelativeTime(at, 'spoken');
  const label = [
    group ? `${title}, group, ${memberCount(conversation.members.length)}` : title,
    unread ? `${conversation.unread} unread` : null,
    preview,
    spokenTime,
  ]
    .filter(Boolean)
    .join(', ');

  const ripple = useRipple();
  return (
    <Pressable
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityActions={onLongPress ? [{ name: 'longpress', label: 'More options' }] : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'longpress') onLongPress?.(conversation);
      }}
      onPress={() => onPress(conversation)}
      onLongPress={onLongPress ? () => onLongPress(conversation) : undefined}
      testID={`conversation-${conversation.key}`}
      className={cn('min-h-[72px] flex-row items-center gap-3 px-4 py-3', tw.bg, tw.pressed)}
    >
      <ConversationAvatar conversation={conversation} size="md" />
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text variant="bodyStrong" numberOfLines={1} className="flex-1" tone={conversation.flags.hidden ? 'secondary' : 'primary'}>
            {title}
          </Text>
          {at ? <RelativeTime date={at} variant="caption" tone="secondary" /> : null}
        </View>
        <View className="flex-row items-center gap-2">
          <Text
            variant="subhead"
            tone={unread ? 'primary' : 'secondary'}
            numberOfLines={1}
            className={cn('flex-1', unread && 'font-semibold')}
          >
            {preview}
          </Text>
          {unread ? <UnreadDot /> : null}
        </View>
      </View>
    </Pressable>
  );
});
