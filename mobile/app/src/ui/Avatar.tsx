import { Image } from 'expo-image';
import { memo, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { cn } from '~/lib-allowlist';

import { useDicebearSvg } from './avatar-svg';
import { useMediaUrls } from './media-url';
import type { CardAvatar } from './post/types';
import { hitSlopFor, motion, tw } from './tokens';

/** UX_SPEC §2.3. `profile` is the web's 128 scaled for phones. */
const AVATAR_SIZES = { xs: 24, sm: 32, md: 40, lg: 48, xl: 64, profile: 88 } as const;
export type AvatarSize = keyof typeof AVATAR_SIZES;

const SVG_DATA_URI = /^data:image\/svg\+xml(;[^,]*)?,([\s\S]*)$/i;

/**
 * The SVG markup inside a `data:image/svg+xml` URI, or null for anything
 * else. The engine renders DiceBear avatars to base64 data URIs
 * (lib/services/avatar-generator); they are drawn locally, never fetched.
 */
export function svgFromDataUri(uri: string): string | null {
  const match = SVG_DATA_URI.exec(uri);
  if (!match) return null;
  const [, params = '', data = ''] = match;
  try {
    if (!/;base64/i.test(params)) return decodeURIComponent(data);
    // atob yields one char per byte; percent-encode them to decode UTF-8.
    const binary = atob(data);
    return decodeURIComponent(
      binary.replace(/[\s\S]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`),
    );
  } catch {
    return null;
  }
}

export interface AvatarProps {
  /** The engine's `AvatarDTO`: an image URI, or a DiceBear recipe drawn via `AvatarSvgProvider`. */
  avatar?: CardAvatar;
  /** Whose avatar: the engine renders a recipe per identity. */
  identityId?: string;
  /** An image URL, or a `data:image/svg+xml` URI. */
  uri?: string;
  /** Raw SVG markup, for a DiceBear avatar the engine handed over as a string. */
  svg?: string;
  /** Shown if `uri` fails to load: the default DiceBear avatar, as a data URI or markup. */
  fallback?: string;
  size?: AvatarSize;
  /** The person's name; makes a tappable avatar read "{name}'s profile". */
  name?: string;
  onPress?: () => void;
  testID?: string;
  className?: string;
}

function svgMarkup(source: string | undefined): string | null {
  if (!source) return null;
  return source.trimStart().startsWith('<') ? source : svgFromDataUri(source);
}

/**
 * A round avatar (web `UserAvatar`): DiceBear SVG drawn with `SvgXml`, any
 * other URL through `expo-image`, a `bg.skeleton` circle while it loads and
 * when there is nothing to show.
 */
export const Avatar = memo(function Avatar({
  avatar,
  identityId,
  uri: uriProp,
  svg: svgProp,
  fallback,
  size = 'md',
  name,
  onPress,
  testID,
  className,
}: AvatarProps) {
  const recipeSvg = useDicebearSvg(identityId, avatar?.dicebear);
  const urls = useMediaUrls();
  const storedUri = avatar?.uri ?? uriProp ?? undefined;
  const svg = svgProp ?? recipeSvg;
  const diameter = AVATAR_SIZES[size];
  // The profile avatar's 4 pt ring sits inside its diameter; the picture fills the rest.
  const inner = size === 'profile' ? diameter - 8 : diameter;
  // Keyed by URL, so a recycled cell showing someone else retries.
  const [failedUri, setFailedUri] = useState<string>();
  const markup = useMemo(() => svgMarkup(svg ?? storedUri), [svg, storedUri]);
  const uri = urls.media(storedUri);
  const fallbackMarkup = useMemo(() => svgMarkup(fallback), [fallback]);

  let content = null;
  // DiceBear art is transparent: it gets a backdrop that keeps black line art visible in dark mode.
  let transparent = false;
  if (markup) {
    transparent = true;
    content = <SvgXml xml={markup} width={inner} height={inner} testID="avatar-svg" />;
  } else if (uri && failedUri !== uri) {
    content = (
      <Image
        source={{ uri }}
        style={{ width: inner, height: inner }}
        contentFit="cover"
        transition={motion.fast}
        recyclingKey={uri}
        onError={() => setFailedUri(uri)}
        accessible={false}
        testID="avatar-image"
      />
    );
  } else if (fallbackMarkup) {
    transparent = true;
    content = <SvgXml xml={fallbackMarkup} width={inner} height={inner} testID="avatar-fallback" />;
  }

  const circle = (
    <View
      testID={onPress ? undefined : testID}
      importantForAccessibility={onPress ? undefined : 'no-hide-descendants'}
      accessibilityElementsHidden={!onPress}
      className={cn(
        'overflow-hidden rounded-full',
        transparent ? tw.avatarBackdrop : tw.bgSkeleton,
        size === 'profile' && 'border-4 border-white dark:border-neutral-900',
        className,
      )}
      style={{ width: diameter, height: diameter }}
    >
      {content}
    </View>
  );

  if (!onPress) return circle;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name ? `${name}'s profile` : 'Profile'}
      hitSlop={hitSlopFor(diameter)}
      onPress={onPress}
      testID={testID}
      className="active:opacity-80"
    >
      {circle}
    </Pressable>
  );
});
