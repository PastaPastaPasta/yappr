import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';

import { cn, truncateId } from '~/lib-allowlist';

import { Avatar } from '../Avatar';
import { RichText } from '../rich-text/RichText';
import { Skeleton } from '../Skeleton';
import { Text } from '../Text';
import { tw } from '../tokens';
import { useRelativeTime } from '../use-relative-time';
import { PrivatePostPlaceholder } from './PrivatePostPlaceholder';
import { SensitiveGate, useSensitiveReveal } from './SensitiveGate';
import { stubText } from './PostStub';
import type { CardPost } from './types';

const FRAME = cn('mt-3 rounded-xl border p-3', tw.borderStrong);

export interface QuoteEmbedProps {
  post: CardPost;
  /** Cover the quoted content with the embedded NSFW gate. */
  nsfwGated?: boolean;
  /** Hide the quoted media thumbnail (author media-gated). */
  mediaGated?: boolean;
  onPress?: () => void;
}

/**
 * A quoted post inside a card (UX_SPEC §2.4.5, web embedded-post-card.tsx):
 * a one-line author row, up to four lines of text and the first image as a
 * thumbnail. The whole frame opens the quoted post.
 */
export function QuoteEmbed({ post, nsfwGated = false, mediaGated = false, onPress }: QuoteEmbedProps) {
  const time = useRelativeTime(post.createdAt);
  const [revealed, reveal] = useSensitiveReveal(post.id);
  const handle = post.author.username ? `@${post.author.username}` : truncateId(post.author.id);
  const thumb = !mediaGated ? post.media[0] : undefined;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Quote: ${post.author.displayName}, ${post.encrypted ? 'private post' : post.content}`}
      onPress={onPress}
      testID="quote-embed"
      className={cn(FRAME, 'active:bg-gray-50 dark:active:bg-gray-950')}
    >
      <View className="flex-row items-center gap-1.5">
        <Avatar uri={post.author.avatarUrl} size="xs" />
        <Text variant="subheadStrong" numberOfLines={1} className="shrink">
          {post.author.displayName}
        </Text>
        <Text variant="subhead" tone="secondary" numberOfLines={1} className="shrink">
          {handle}
        </Text>
        <Text variant="subhead" tone="secondary">
          · {time}
        </Text>
      </View>
      {post.deleted ? (
        <Text variant="subhead" tone="secondary" className="mt-1 italic">
          {stubText('deleted', post.kind)}
        </Text>
      ) : post.encrypted ? (
        <PrivatePostPlaceholder name={post.author.displayName} compact />
      ) : (
        <SensitiveGate active={nsfwGated} revealed={revealed} onReveal={reveal} variant="embedded">
          <View className="mt-1 flex-row gap-3">
            <View className="flex-1">
              <RichText text={post.content} variant="subhead" numberOfLines={4} />
            </View>
            {thumb ? (
              <Image
                source={{ uri: thumb.thumbnail ?? thumb.url }}
                style={{ width: 64, height: 64, borderRadius: 8 }}
                contentFit="cover"
                accessible={false}
              />
            ) : null}
          </View>
        </SensitiveGate>
      )}
    </Pressable>
  );
}

/** The quote slot while the quoted post loads: two bars in the frame. */
export function QuoteSkeleton() {
  return (
    <View accessible accessibilityLabel="Loading quoted post" className={cn(FRAME, 'gap-2')} testID="quote-skeleton">
      <Skeleton width="50%" />
      <Skeleton width="85%" />
    </View>
  );
}
