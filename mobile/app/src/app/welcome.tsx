import { Image } from 'expo-image';
import { router } from 'expo-router';
import { View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import pbdeDark from '@assets/images/pbde-dark.png';
import pbdeLight from '@assets/images/pbde-light.png';
import { config } from '~/config';
import { useEngineStatus } from '~/engine/hooks';
import { copy } from '~/features/auth/copy';
import { links, openInApp, setWelcomed } from '~/features/auth/onboarding';
import { Wordmark } from '~/features/auth/Wordmark';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { NetworkChip, type EngineState } from '~/ui/NetworkChip';
import { Text } from '~/ui/Text';
import { tw, useIsDark } from '~/ui/tokens';

/** Web's hero `motion.div`: fade in and rise 20 pt over 500 ms (none with Reduce Motion). */
const ENTER = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 20 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }] },
}).duration(500);

function useChipState(): EngineState {
  const { state } = useEngineStatus();
  if (state === 'ready' || state === 'degraded') return 'ready';
  if (state === 'failed' || state === 'unsupported') return 'unavailable';
  return 'booting';
}

/**
 * UX_SPEC §4.1, PRD AUTH-01: what Yappr is, then sign in or look around.
 * Static and offline; either choice is remembered.
 */
export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();
  const dark = useIsDark();
  const chipState = useChipState();

  const leave = (next: 'sign-in' | 'browse') => {
    setWelcomed(true);
    if (next === 'sign-in') router.replace('/sign-in');
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <View
      className={cn('flex-1 px-6', tw.bg)}
      style={{ paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 16) }}
      testID="welcome"
    >
      <View className="min-h-6 flex-row justify-end">
        <NetworkChip network={config.network} state={chipState} />
      </View>

      <Animated.View entering={ENTER} className="flex-1 items-center justify-center gap-6">
        <Wordmark size={64} />
        <Text variant="bodyLarge" tone="secondary" className="max-w-[340px] text-center">
          {copy.welcome.tagline}
        </Text>
        <Image
          source={dark ? pbdeDark : pbdeLight}
          style={{ width: 240, height: 99 }}
          contentFit="contain"
          accessibilityLabel={copy.welcome.poweredBy}
          accessible
        />
      </Animated.View>

      <Animated.View entering={ENTER} className="gap-3">
        <Button
          label={copy.welcome.signIn}
          size="block"
          className="shadow-yappr-lg"
          testID="welcome-sign-in"
          onPress={() => leave('sign-in')}
        />
        <Button
          label={copy.welcome.browse}
          variant="outline"
          size="block"
          testID="welcome-browse"
          onPress={() => leave('browse')}
        />
        <View className="flex-row items-center justify-center">
          <Button label={copy.welcome.terms} variant="link" size="sm" onPress={() => openInApp(links.terms)} />
          <Text variant="caption" tone="secondary" importantForAccessibility="no" accessibilityElementsHidden>
            ·
          </Text>
          <Button label={copy.welcome.privacy} variant="link" size="sm" onPress={() => openInApp(links.privacy)} />
        </View>
      </Animated.View>
    </View>
  );
}
