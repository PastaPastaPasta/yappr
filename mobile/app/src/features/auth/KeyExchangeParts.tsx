import * as Clipboard from 'expo-clipboard';
import { useKeepAwake } from 'expo-keep-awake';
import { useNavigation } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import { CheckCircleIcon, ExclamationTriangleIcon, WalletIcon } from 'react-native-heroicons/outline';
import QRCode from 'react-native-qrcode-svg';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { selectionTick } from '~/ui/haptics';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { colors, motion, tw, useColors } from '~/ui/tokens';

import { copy } from './copy';
import { cancelKeyExchange, resetKeyExchange, useKeyExchange, walletReturned } from './key-exchange';
import { useCloseSignIn } from './navigation';

/** The 64 pt wallet glyph; it breathes while the app waits on the wallet (UX_SPEC §4.3). */
export function WalletGlyph({ pulsing }: { pulsing: boolean }) {
  const c = useColors();
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const animate = pulsing && !reduceMotion;
  useEffect(() => {
    if (!animate) {
      scale.set(1);
      return undefined;
    }
    scale.set(withRepeat(withTiming(1.08, { duration: motion.pulse / 2 }), -1, true));
    return () => cancelAnimation(scale);
  }, [animate, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View style={style} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View className="h-24 w-24 items-center justify-center rounded-full bg-yappr-50 dark:bg-yappr-950/40">
        <WalletIcon size={64} color={c.accent} strokeWidth={1.25} />
      </View>
    </Animated.View>
  );
}

export type StatusTone = 'waiting' | 'busy' | 'done' | 'error';

/** A centered status: glyph, headline and a secondary line (UX_SPEC §4.3 states). */
export function StatusBlock({
  tone,
  title,
  body,
  children,
  testID,
}: {
  tone: StatusTone;
  title: string;
  body?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const c = useColors();
  let glyph: ReactNode;
  if (tone === 'done') glyph = <CheckCircleIcon size={64} color={c.repost} strokeWidth={1.5} />;
  else if (tone === 'error') glyph = <ExclamationTriangleIcon size={56} color={c.warning} strokeWidth={1.5} />;
  else if (tone === 'busy') glyph = <Spinner size="lg" />;
  else glyph = <WalletGlyph pulsing />;
  return (
    <View className="items-center gap-3 py-6" testID={testID}>
      <View className="mb-2 h-24 items-center justify-center">{glyph}</View>
      <Text
        variant="headline"
        tone="emphasis"
        className="text-center"
        accessibilityRole="header"
        accessibilityLiveRegion="polite"
      >
        {title}
      </Text>
      {body ? (
        <Text variant="subhead" tone="secondary" className="max-w-[320px] text-center">
          {body}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/**
 * The request as a QR code (AUTH-04): at least 240 pt, on white with a
 * 16 pt quiet zone in both themes, so any wallet camera reads it.
 */
export function QrCard({ value, dimmed = false, testID }: { value: string; dimmed?: boolean; testID?: string }) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Sign-in QR code"
      testID={testID}
      className={cn('self-center rounded-2xl border bg-white p-4', tw.border, dimmed && 'opacity-30')}
    >
      <QRCode value={value} size={240} color={colors.black} backgroundColor={colors.white} ecl="M" />
    </View>
  );
}

/** "Copy link", then "Copied" for 2 s (AUTH-04, web wording). */
export function CopyLinkButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      label={copied ? copy.signin.copied : copy.signin.copyLink}
      variant="secondary"
      size="sm"
      layoutStyle={{ alignSelf: 'center' }}
      testID="kx-copy-link"
      onPress={() => {
        Clipboard.setStringAsync(value)
          .then(() => {
            selectionTick();
            setCopied(true);
          })
          .catch(() => undefined);
      }}
    />
  );
}

/** "Waiting for approval… ◌" under the QR code. */
export function WaitingLine({ label = copy.signin.qrWaiting }: { label?: string }) {
  return (
    <View className="flex-row items-center justify-center gap-2" accessibilityLiveRegion="polite">
      <Text variant="subhead" tone="secondary">
        {label}
      </Text>
      <Spinner size="sm" color={colors.gray500} />
    </View>
  );
}

/**
 * Dev builds only: the wallet link as text, so Maestro can hand it to the
 * test-wallet responder (ADR-001 E5.4). Never rendered in release builds.
 */
export function DevWalletUri({ uri }: { uri: string | null }) {
  if (!__DEV__ || !uri) return null;
  return (
    <Text
      variant="caption"
      tone="decorative"
      selectable
      numberOfLines={1}
      ellipsizeMode="middle"
      testID="kx-uri"
      accessibilityLabel={uri}
      className="text-center"
    >
      {uri}
    </Text>
  );
}

/** Poll again whenever the app comes back to the foreground (AUTH-03): the user may have just approved. */
export function useForegroundRepoll(): void {
  const lastState = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const previous = lastState.current;
      lastState.current = state;
      if (state === 'active' && previous !== 'active') walletReturned();
    });
    return () => subscription.remove();
  }, []);
}

/** The QR screens keep the display awake while shown (AUTH-04). */
export function KeepAwake() {
  useKeepAwake('yappr-sign-in-qr');
  return null;
}

/**
 * After the wallet sign-in lands: "Signed in" for a moment, then the
 * terms gate or back where the user was.
 */
export function useSignedInHandoff(): void {
  const phase = useKeyExchange((s) => s.phase);
  const close = useCloseSignIn();
  const signedIn = phase.name === 'signed-in';
  useEffect(() => {
    if (!signedIn) return undefined;
    const timer = setTimeout(() => {
      resetKeyExchange();
      close();
    }, 900);
    return () => clearTimeout(timer);
  }, [signedIn, close]);
}

/**
 * Leaving a wallet screen by going back abandons its request (AUTH-03
 * "Cancel"); replacing it with the next step (registration) does not.
 */
export function useCancelOnBack(): void {
  const navigation = useNavigation();
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (event) => {
        const type = event.data.action.type;
        if (type === 'GO_BACK' || type === 'POP' || type === 'POP_TO_TOP') cancelKeyExchange();
      }),
    [navigation],
  );
}
