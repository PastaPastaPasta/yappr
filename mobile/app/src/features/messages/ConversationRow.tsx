import type { ConversationDTO } from '@engine/api';
import { memo } from 'react';
import { Pressable, View } from 'react-native';

import { cn, formatTime } from '~/lib-allowlist';
import { UnreadDot } from '~/ui/Badge';
import { RelativeTime } from '~/ui/RelativeTime';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

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
  const at = conversation.lastActivity ? new Date(conversation.lastActivity) : null;
  const group = conversation.kind === 'group';
  const label = [
    group ? `${title}, group, ${memberCount(conversation.members.length)}` : title,
    unread ? `${conversation.unread} unread` : null,
    preview,
    at ? formatTime(at) : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Pressable
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
