import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';
import { PhotoIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';

import { Avatar } from '../Avatar';
import { RichText } from '../rich-text/RichText';
import { handleOf } from '../handle';
import { useMediaUrls } from '../media-url';
import { Skeleton, SkeletonGroup } from '../Skeleton';
import { Text } from '../Text';
import { tw, useColors } from '../tokens';
import { RelativeTime } from '../RelativeTime';
import { PrivatePostPlaceholder } from './PrivatePostPlaceholder';
import { SensitiveGate, useSensitiveReveal } from './SensitiveGate';
import { EMBED_FRAME } from './embed-frame';
import { DeletedLine, stubText } from './PostStub';
import type { CardPost } from './types';

const FRAME = cn(EMBED_FRAME, 'p-3');

export interface QuoteEmbedProps {
  post: CardPost;
  /** Cover the quoted content with the embedded NSFW gate. */
  nsfwGated?: boolean;
  /** Hide the quoted media thumbnail (author media-gated) behind a "Show" tile. */
  mediaGated?: boolean;
  /** The gated thumbnail's "Show": reveals the card's media. */
  onRevealMedia?: () => void;
  onPress?: () => void;
}

/**
 * A quoted post inside a card (UX_SPEC §2.4.5, web embedded-post-card.tsx):
 * a one-line author row, up to four lines of text and the first image as a
 * thumbnail. The whole frame opens the quoted post.
 */
export function QuoteEmbed({ post, nsfwGated = false, mediaGated = false, onRevealMedia, onPress }: QuoteEmbedProps) {
  const [revealed, reveal] = useSensitiveReveal(post.id);
  const c = useColors();
  const handle = handleOf(post.author);
  const urls = useMediaUrls();
  const first = post.media[0];
  const source = first ? (first.thumbnail ?? (first.type === 'video' ? undefined : first.url)) : undefined;
  const thumb = source && !mediaGated ? urls.media(source) : undefined;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Quote: ${post.author.displayName}, ${
        post.deleted
          ? stubText('deleted', post.kind)
          : post.encrypted
            ? 'private post'
            : nsfwGated && !revealed
              ? 'NSFW post, hidden'
              : post.content
      }`}
      onPress={onPress}
      testID="quote-embed"
      className={cn(FRAME, tw.pressed)}
    >
      <View className="flex-row items-center gap-1.5">
        <Avatar avatar={post.author.avatar} identityId={post.author.id} size="xs" />
        <Text variant="subheadStrong" numberOfLines={1} className="shrink">
          {post.author.displayName}
        </Text>
        <Text variant="subhead" tone="secondary" numberOfLines={1} className="shrink">
          {handle}
        </Text>
        <RelativeTime date={post.createdAt} prefix="· " variant="subhead" tone="secondary" />
      </View>
      {post.deleted ? (
        <DeletedLine kind={post.kind} />
      ) : post.encrypted ? (
        <PrivatePostPlaceholder compact />
      ) : (
        <SensitiveGate active={nsfwGated} revealed={revealed} onReveal={reveal} variant="embedded">
          <View className="mt-1 flex-row gap-3">
            <View className="flex-1">
              <RichText text={post.content} variant="subhead" numberOfLines={4} />
            </View>
            {thumb ? (
              <Image
                source={{ uri: thumb }}
                style={{ width: 64, height: 64, borderRadius: 8 }}
                contentFit="cover"
                recyclingKey={thumb}
                accessible={false}
              />
            ) : source && mediaGated ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Show media. Media from someone you don't follow."
                onPress={onRevealMedia}
                disabled={!onRevealMedia}
                testID="quote-media-gate"
                className={cn('items-center justify-center gap-0.5 rounded-lg', tw.bgMuted, tw.pressedMuted)}
                style={{ width: 64, height: 64 }}
              >
                <PhotoIcon size={20} color={c.textSecondary} />
                <Text variant="caption" tone="secondary">
                  Show
                </Text>
              </Pressable>
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
    <SkeletonGroup label="Loading quoted post" className={cn(FRAME, 'gap-2')} testID="quote-skeleton">
      <Skeleton width="50%" />
      <Skeleton width="85%" />
    </SkeletonGroup>
  );
}
