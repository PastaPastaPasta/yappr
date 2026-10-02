import { useRecyclingState } from '@shopify/flash-list';
import * as Clipboard from 'expo-clipboard';
import { memo, type ReactNode } from 'react';
import { Pressable, Text as RNText, View } from 'react-native';

import { openExternal } from '~/features/post/post-navigation';
import { cn, formatTime, isEmojiOnly } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { Avatar } from '~/ui/Avatar';
import { selectionTick } from '~/ui/haptics';
import { useMediaUrls } from '~/ui/media-url';
import type { CardAvatar } from '~/ui/post/types';
import { splitUrl } from '~/ui/rich-text/parse';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';

import { dayLabel, timeLabel, type TimelineItem } from './dm-model';

type MessageItem = Extract<TimelineItem, { type: 'message' }>;

export interface MessageBubbleProps {
  item: MessageItem;
  /** Group conversations show the sender's name and avatar on others' runs. */
  group: boolean;
  senderName?: string;
  senderAvatar?: CardAvatar;
  /** A failed local send was tapped: retry, check or edit it. */
  onResolve?: (id: string) => void;
  onSenderPress?: (id: string) => void;
}

/** `radius.2xl`, with the corner nearest the sender squared on a run's last bubble (`radius.sm`). */
const ROUND = { borderRadius: 16 } as const;
const TAIL_OWN = { borderRadius: 16, borderBottomRightRadius: 4 } as const;
const TAIL_OTHER = { borderRadius: 16, borderBottomLeftRadius: 4 } as const;

const URL_PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

/** Message text with tappable links (PRD DM-03: media URLs are links, never fetched). */
function Linkified({ text, own }: { text: string; own: boolean }) {
  const urls = useMediaUrls();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const { href, display, trailing } = splitUrl(match[0]);
    const target = urls.external(href.startsWith('www.') ? `https://${href}` : href);
    parts.push(
      <RNText
        key={index}
        accessibilityRole="link"
        suppressHighlighting
        onPress={target ? () => openExternal(target) : undefined}
        className={cn('underline', own ? 'text-white' : 'text-yappr-700 dark:text-yappr-400')}
      >
        {display}
      </RNText>,
      trailing,
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function copyMessage(text: string): void {
  Clipboard.setStringAsync(text)
    .then(() => {
      selectionTick();
      toast.success('Copied');
    })
    .catch(() => toast.error("Couldn't copy"));
}

/**
 * A DM bubble (UX_SPEC §2.23): own on the right in the accent fill with white
 * text, others on the left in `bubble.other`; the corner nearest the sender
 * squared on a run's last bubble; emoji-only messages large and bare. Tap
 * shows the time; long-press offers "Copy".
 */
export const MessageBubble = memo(function MessageBubble({
  item,
  group,
  senderName,
  senderAvatar,
  onResolve,
  onSenderPress,
}: MessageBubbleProps) {
  const { message, firstOfRun, lastOfRun, status, statusIsError } = item;
  // FlashList reuses this cell for other messages: the shown time belongs to this one.
  const [showTime, setShowTime] = useRecyclingState(false, [message.id]);
  const own = message.own;
  const emoji = isEmojiOnly(message.text);
  const failed = statusIsError && !!message.outbox;
  const othersInGroup = group && !own;

  const onPress = () => {
    if (failed) onResolve?.(message.id);
    else setShowTime((shown) => !shown);
  };
  const onLongPress = () =>
    showActionSheet({
      title: `${dayLabel(message.at)} at ${timeLabel(message.at)}`,
      actions: [{ label: 'Copy', onPress: () => copyMessage(message.text) }],
    });

  const bubbleShape = cn(
    'px-3.5 py-2.5',
    own ? 'bg-yappr-600 dark:bg-yappr-500' : 'bg-gray-100 dark:bg-gray-900',
    // The engine's own copies are out already ("Sent"); only a send still on its way is faded.
    (message.outbox === 'sending' || failed) && 'opacity-70',
  );

  const a11y = [
    own ? 'You' : (senderName ?? 'Them'),
    message.text,
    formatTime(message.at),
    status,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View className={cn('px-3', firstOfRun ? 'mt-2' : 'mt-0.5')} testID={own ? 'dm-message-own' : 'dm-message'}>
      {othersInGroup && firstOfRun && senderName ? (
        <Text variant="captionStrong" tone="secondary" className="mb-0.5 ml-10" numberOfLines={1}>
          {senderName}
        </Text>
      ) : null}
      <View className={cn('flex-row items-end gap-2', own ? 'justify-end' : 'justify-start')}>
        {othersInGroup ? (
          <View style={{ width: 24 }}>
            {lastOfRun ? (
              <Avatar
                avatar={senderAvatar}
                identityId={message.sender}
                size="xs"
                name={senderName}
                onPress={onSenderPress ? () => onSenderPress(message.sender) : undefined}
              />
            ) : null}
          </View>
        ) : null}
        <Pressable
          accessibilityRole={failed ? 'button' : 'text'}
          accessibilityLabel={a11y}
          accessibilityHint={failed ? status ?? undefined : 'Long press to copy'}
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={350}
          style={{ maxWidth: '78%' }}
          testID={message.outbox ? `dm-outbox-${message.outbox}` : undefined}
        >
          {emoji ? (
            <Text className={cn('text-4xl leading-snug', message.outbox === 'sending' && 'opacity-70')}>{message.text}</Text>
          ) : (
            <View className={bubbleShape} style={lastOfRun ? (own ? TAIL_OWN : TAIL_OTHER) : ROUND}>
              <Text variant="body" tone={own ? 'inverse' : 'primary'} style={{ writingDirection: 'auto' }}>
                <Linkified text={message.text} own={own} />
              </Text>
            </View>
          )}
        </Pressable>
      </View>
      {showTime ? (
        <Text variant="caption" tone="secondary" className={cn('mt-0.5', own ? 'text-right' : 'ml-1', othersInGroup && 'ml-10')}>
          {timeLabel(message.at)}
        </Text>
      ) : null}
      {status ? (
        <Pressable
          disabled={!failed}
          accessibilityRole={failed ? 'button' : undefined}
          onPress={() => onResolve?.(message.id)}
          className={cn('mt-0.5', own ? 'self-end' : 'self-start')}
          testID={failed ? 'dm-status-error' : 'dm-status'}
        >
          <Text variant="caption" tone={statusIsError ? 'error' : 'secondary'}>
            {status}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

/** The day separator: centered `caption` `text.secondary` with 16 vertical margin. */
export function DaySeparator({ label }: { label: string }) {
  return (
    <View accessibilityRole="header" className="items-center py-4">
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
    </View>
  );
}
