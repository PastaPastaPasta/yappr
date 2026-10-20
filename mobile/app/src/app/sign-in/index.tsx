import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ChevronDownIcon, ChevronRightIcon, KeyIcon } from 'react-native-heroicons/outline';

import { useCapabilities, useSessionStore } from '~/data/session';
import { accountName, useReauthTarget } from '~/features/auth/accounts';
import { copy } from '~/features/auth/copy';
import { links, openInApp } from '~/features/auth/onboarding';
import { useCloseSignIn } from '~/features/auth/navigation';
import { HeaderClose, SignInBody } from '~/features/auth/SignInChrome';
import { cn } from '~/lib-allowlist';
import { Lockup } from '~/ui/brand/Brand';
import { Button } from '~/ui/Button';
import { Text } from '~/ui/Text';
import { motion, tw, useColors, type IconComponent } from '~/ui/tokens';

/**
 * Whether an app on this device handles `dash-key:` links (AUTH-05). iOS
 * answers only for schemes listed in LSApplicationQueriesSchemes, Android
 * only for intents declared in <queries> (both in app.config.ts). null
 * while asking.
 */
function useWalletInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    Linking.canOpenURL('dash-key:yappr')
      .then((can) => {
        if (live) setInstalled(can);
      })
      .catch(() => {
        if (live) setInstalled(false);
      });
    return () => {
      live = false;
    };
  }, []);
  return installed;
}

function MethodRow({
  label,
  icon: Icon,
  onPress,
  testID,
}: {
  label: string;
  icon: IconComponent;
  onPress: () => void;
  testID?: string;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      className={cn('min-h-12 flex-row items-center gap-3 px-4 py-3', tw.pressed)}
    >
      <Icon size={20} color={c.textSecondary} />
      <Text variant="body" className="flex-1">
        {label}
      </Text>
      <ChevronRightIcon size={18} color={c.textSecondary} />
    </Pressable>
  );
}

/**
 * UX_SPEC §4.2: wallet first, a private key under "Other ways". The wallet
 * sign-in is App Connect on networks that run it (devnet), the legacy key
 * exchange elsewhere; until the engine says which (a first launch), the
 * wallet buttons wait.
 */
export default function SignInScreen() {
  const c = useColors();
  const close = useCloseSignIn();
  const walletInstalled = useWalletInstalled();
  const [showOther, setShowOther] = useState(false);
  const reauth = useReauthTarget();
  const reauthAccount = useSessionStore((s) => s.accounts.find((a) => a.identityId === reauth));
  const reauthName = reauth ? accountName(reauthAccount ?? { identityId: reauth, username: null }) : null;
  const walletSignIn = useCapabilities()?.walletSignIn ?? null;
  const sameDevice = walletSignIn === 'app-connect' ? '/sign-in/connect?mode=wallet' : '/sign-in/wallet';
  const otherDevice = walletSignIn === 'app-connect' ? '/sign-in/connect?mode=qr' : '/sign-in/qr';

  const toggleOther = () => {
    setShowOther((open) => !open);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: '',
          headerShadowVisible: false,
          headerLeft: () => <HeaderClose onPress={close} />,
        }}
      />
      <SignInBody testID="sign-in-screen">
        <View className="items-center gap-3 pt-4">
          <Lockup height={40} header />
          <Text variant="titleLarge" tone="emphasis" className="text-center">
            {copy.signin.title}
          </Text>
          <Text variant="body" tone="secondary" className="max-w-[320px] text-center">
            {copy.signin.subtitle}
          </Text>
          {reauthName ? (
            <Text variant="subhead" tone="error" className="max-w-[320px] text-center" testID="sign-in-reauth">
              {copy.signin.reauth(reauthName)}
            </Text>
          ) : null}
        </View>

        <View className="gap-3 pt-4">
          {walletInstalled === false ? (
            <>
              <View className={cn('rounded-xl p-4', tw.bgMuted)} testID="sign-in-no-wallet">
                <Text variant="subhead" tone="secondary">
                  {copy.signin.noWallet}
                </Text>
              </View>
              <Button
                label={copy.signin.getWallet}
                size="block"
                testID="sign-in-get-wallet"
                onPress={() => openInApp(links.getWallet)}
              />
            </>
          ) : (
            <Button
              label={copy.signin.openWallet}
              size="block"
              loading={walletInstalled === null || walletSignIn === null}
              testID="sign-in-open-wallet"
              onPress={() => router.push(sameDevice)}
            />
          )}
          <Button
            label={copy.signin.otherDevice}
            variant="outline"
            size="block"
            loading={walletSignIn === null}
            testID="sign-in-other-device"
            onPress={() => router.push(otherDevice)}
          />
        </View>

        <View className={cn('mt-2 overflow-hidden rounded-xl border', tw.border)}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showOther }}
            onPress={toggleOther}
            testID="sign-in-other-ways"
            className={cn('min-h-12 flex-row items-center px-4 py-3', tw.pressed)}
          >
            <Text variant="bodyStrong" className="flex-1">
              {copy.signin.other}
            </Text>
            <View style={{ transform: [{ rotate: showOther ? '180deg' : '0deg' }] }}>
              <ChevronDownIcon size={18} color={c.textSecondary} />
            </View>
          </Pressable>
          {showOther ? (
            <Animated.View entering={FadeIn.duration(motion.base)} className={cn('border-t', tw.border)}>
              <MethodRow
                label={copy.signin.privateKey}
                icon={KeyIcon}
                testID="sign-in-private-key"
                onPress={() => router.push('/sign-in/key')}
              />
            </Animated.View>
          ) : null}
        </View>

        <View className="flex-row flex-wrap items-center justify-center gap-1 pt-2">
          <Text variant="subhead" tone="secondary">
            {copy.signin.newToDash}
          </Text>
          <Button
            label={copy.signin.createIdentity}
            variant="link"
            size="sm"
            className="px-1"
            testID="sign-in-new-to-dash"
            onPress={() => openInApp(links.identityBridge)}
          />
        </View>
      </SignInBody>
    </>
  );
}
