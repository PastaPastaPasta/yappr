import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { PhotoIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';

import { Button } from '../Button';
import { Text } from '../Text';
import { tw, useColors } from '../tokens';
import type { CardMedia } from './types';

const VIDEO = 16 / 9;
const TALL = 4 / 5;

/** One item keeps its own shape between 16:9 and 4:5; unknown sizes are 16:9 (UX_SPEC §2.4.6). */
export function singleAspectRatio(media: Pick<CardMedia, 'width' | 'height'>): number {
  if (!media.width || !media.height) return VIDEO;
  return Math.min(VIDEO, Math.max(TALL, media.width / media.height));
}

/**
 * The media gate (UX_SPEC §2.7): a flat `bg.muted` stand-in for media from
 * someone the viewer doesn't follow. Nothing remote loads before "Show".
 */
export function MediaGatePlaceholder({ onReveal, className }: { onReveal?: () => void; className?: string }) {
  const c = useColors();
  return (
    <View
      accessible
      accessibilityLabel="Media hidden. Media from someone you don't follow."
      accessibilityActions={onReveal ? [{ name: 'activate', label: 'Show' }] : undefined}
      onAccessibilityAction={onReveal}
      testID="media-gate"
      className={cn('aspect-video w-full items-center justify-center gap-2 rounded-xl p-4', tw.bgMuted, className)}
    >
      <PhotoIcon size={32} color={c.textSecondary} />
      <Text variant="subhead" tone="secondary" className="text-center">
        Media from someone you don&apos;t follow
      </Text>
      {onReveal ? <Button label="Show" variant="secondary" size="sm" onPress={onReveal} testID="media-gate-show" /> : null}
    </View>
  );
}

function MediaCell({ media, onPress, className }: { media: CardMedia; onPress?: () => void; className?: string }) {
  const c = useColors();
  const [failedUrl, setFailedUrl] = useState<string>();
  const failed = failedUrl === media.url;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={media.alt || 'Image'}
      disabled={!onPress}
      onPress={onPress}
      className={cn('overflow-hidden', tw.bgSkeleton, className)}
    >
      {failed ? (
        <View className={cn('flex-1 items-center justify-center gap-1', tw.bgMuted)}>
          <PhotoIcon size={32} color={c.textSecondary} />
          <Text variant="caption" tone="secondary">
            Image unavailable
          </Text>
        </View>
      ) : (
        <Image
          source={{ uri: media.thumbnail ?? media.url }}
          style={{ flex: 1 }}
          contentFit="cover"
          transition={150}
          recyclingKey={media.url}
          onError={() => setFailedUrl(media.url)}
          accessible={false}
        />
      )}
    </Pressable>
  );
}

export interface MediaGridProps {
  media: CardMedia[];
  /** Media from a non-followed author: one placeholder for the whole grid. */
  gated?: boolean;
  onReveal?: () => void;
  onMediaPress?: (index: number) => void;
}

/**
 * The post media grid (web `grid gap-1 rounded-xl`, UX_SPEC §2.4.6): one
 * item at its own clamped ratio; two side by side at 16:9 each; three with
 * the first spanning both rows; four in a 2 × 2; 2 pt gaps.
 */
export function MediaGrid({ media, gated = false, onReveal, onMediaPress }: MediaGridProps) {
  if (media.length === 0) return null;
  if (gated) return <MediaGatePlaceholder onReveal={onReveal} className="mt-3" />;

  const items = media.slice(0, 4);
  const cell = (index: number, className = 'flex-1') => (
    <MediaCell
      key={index}
      media={items[index]}
      className={className}
      onPress={onMediaPress && (() => onMediaPress(index))}
    />
  );

  return (
    <View testID="media-grid" className="mt-3 overflow-hidden rounded-xl">
      {items.length === 1 ? (
        <View style={{ aspectRatio: singleAspectRatio(items[0]) }}>{cell(0)}</View>
      ) : items.length === 2 ? (
        <View className="flex-row gap-0.5">
          {cell(0, 'flex-1 aspect-video')}
          {cell(1, 'flex-1 aspect-video')}
        </View>
      ) : (
        <View className="aspect-video flex-row gap-0.5">
          <View className="flex-1 gap-0.5">
            {cell(0)}
            {items.length === 4 ? cell(2) : null}
          </View>
          <View className="flex-1 gap-0.5">
            {cell(1)}
            {cell(items.length === 4 ? 3 : 2)}
          </View>
        </View>
      )}
    </View>
  );
}
