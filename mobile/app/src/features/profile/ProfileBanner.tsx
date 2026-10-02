import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useMediaUrls } from '~/ui/media-url';
import { colors, motion } from '~/ui/tokens';

/**
 * `gradient-yappr` (UX_SPEC §1.3): 135°, yappr-500 → yappr-600. Drawn with
 * react-native-svg, since NativeWind can't render `background-image` and the
 * shared dev client has no expo-linear-gradient.
 */
export function YapprGradient() {
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="gradient-yappr" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={colors.yappr500} />
          <Stop offset="1" stopColor={colors.yappr600} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#gradient-yappr)" />
    </Svg>
  );
}

export interface ProfileBannerProps {
  uri?: string;
  /** Media from someone the viewer doesn't follow: the plain gradient, no "Show" (UX_SPEC §4.12). */
  gated?: boolean;
  height: number;
}

/** The profile banner: the image, else (or while gated, or when it fails) the default gradient. */
export function ProfileBanner({ uri, gated = false, height }: ProfileBannerProps) {
  const urls = useMediaUrls();
  const source = gated ? undefined : urls.media(uri);
  const [failed, setFailed] = useState<string>();
  return (
    <View
      style={{ height }}
      className="w-full overflow-hidden"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="profile-banner"
    >
      <YapprGradient />
      {source && failed !== source ? (
        <Image
          source={{ uri: source }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={motion.base}
          onError={() => setFailed(source)}
          testID="profile-banner-image"
        />
      ) : null}
    </View>
  );
}
