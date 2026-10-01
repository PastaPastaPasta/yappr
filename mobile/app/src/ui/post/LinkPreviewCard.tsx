import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { PlayIcon } from 'react-native-heroicons/solid';

import { cn } from '~/lib-allowlist';

import { Skeleton } from '../Skeleton';
import { Text } from '../Text';
import { colors, tw } from '../tokens';
import { MediaGatePlaceholder } from './MediaGrid';
import type { CardLinkPreview, Loadable } from './types';

/**
 * The host without `www.`. A regex, not `new URL`: React Native's URL
 * polyfill doesn't implement `hostname`.
 */
export function displayHost(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url);
  return (match?.[1] ?? url).replace(/^www\./i, '');
}

const FRAME = cn('mt-3 overflow-hidden rounded-xl border', tw.borderStrong);

export interface LinkPreviewCardProps {
  preview: Loadable<CardLinkPreview>;
  /** The author is media-gated: the image box shows the gate instead. */
  mediaGated?: boolean;
  onRevealMedia?: () => void;
  onPress?: (url: string) => void;
}

/**
 * The link card under a post (UX_SPEC §2.4.7, web link-preview.tsx): image
 * on top, then domain, title and description. YouTube links get a play
 * button over the thumbnail and open outside the app (no inline player in
 * 1.0). A failed fetch renders nothing.
 */
export function LinkPreviewCard({ preview, mediaGated = false, onRevealMedia, onPress }: LinkPreviewCardProps) {
  const [imageFailed, setImageFailed] = useState(false);

  if (preview === 'error') return null;
  if (preview === 'loading') {
    return (
      <View accessible accessibilityLabel="Loading link preview" className={FRAME} testID="link-preview-skeleton">
        <View className={cn('aspect-video', tw.bgSkeleton)} />
        <View className="gap-2 p-3">
          <Skeleton width="40%" />
          <Skeleton width="80%" />
        </View>
      </View>
    );
  }

  const host = displayHost(preview.url);
  const youtube = preview.youtubeVideoId;
  const image = youtube ? `https://img.youtube.com/vi/${youtube}/hqdefault.jpg` : preview.image;
  const label = [youtube ? 'YouTube video' : host, preview.title].filter(Boolean).join(', ');

  let imageBox = null;
  if (mediaGated && image) {
    imageBox = <MediaGatePlaceholder onReveal={onRevealMedia} className="rounded-none" />;
  } else if (image && !imageFailed) {
    imageBox = (
      <View className={cn('aspect-video', youtube ? 'bg-black' : tw.bgSkeleton)}>
        <Image
          source={{ uri: image }}
          style={{ flex: 1 }}
          contentFit="cover"
          onError={() => setImageFailed(true)}
          accessible={false}
        />
        {youtube ? (
          <View className="absolute inset-0 items-center justify-center">
            <View className="h-12 w-12 items-center justify-center rounded-full bg-red-600 shadow-lg">
              <PlayIcon size={24} color={colors.white} style={{ marginLeft: 3 }} />
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress && (() => onPress(preview.url))}
      testID="link-preview"
      className={cn(FRAME, 'active:bg-gray-50 dark:active:bg-gray-950')}
    >
      {imageBox}
      <View className="gap-0.5 px-3 py-2.5">
        <Text variant="caption" tone="secondary" numberOfLines={1}>
          {youtube ? 'YouTube' : (preview.siteName ?? host)}
        </Text>
        {preview.title ? (
          <Text variant="subheadStrong" numberOfLines={2}>
            {preview.title}
          </Text>
        ) : null}
        {preview.description && !youtube ? (
          <Text variant="subhead" tone="secondary" numberOfLines={2}>
            {preview.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
