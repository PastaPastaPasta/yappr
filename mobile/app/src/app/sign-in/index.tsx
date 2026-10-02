import { router, Stack } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ChevronDownIcon, ChevronRightIcon, KeyIcon, LinkIcon } from 'react-native-heroicons/outline';

import { useSessionStore } from '~/data/session';
import { accountName, useReauthTarget } from '~/features/auth/accounts';
import { copy } from '~/features/auth/copy';
import { FEATURE_APP_CONNECT, links, openInApp } from '~/features/auth/onboarding';
import { useCloseSignIn } from '~/features/auth/navigation';
import { HeaderClose, SignInBody } from '~/features/auth/SignInChrome';
import { Wordmark } from '~/features/auth/Wordmark';
import { cn } from '~/lib-allowlist';
import { Tag } from '~/ui/Badge';
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
  disabled,
  trailing,
  testID,
}: {
  label: string;
  icon: IconComponent;
  onPress?: () => void;
  disabled?: boolean;
  trailing?: ReactNode;
  testID?: string;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className={cn('min-h-12 flex-row items-center gap-3 px-4 py-3', tw.pressed, disabled && 'opacity-60')}
    >
      <Icon size={20} color={c.textSecondary} />
      <Text variant="body" className="flex-1">
        {label}
      </Text>
      {trailing ?? <ChevronRightIcon size={18} color={c.textSecondary} />}
    </Pressable>
  );
}

/** UX_SPEC §4.2: wallet first; a private key and (flagged off) App Connect under "Other ways". */
export default function SignInScreen() {
  const c = useColors();
  const close = useCloseSignIn();
  const walletInstalled = useWalletInstalled();
  const [showOther, setShowOther] = useState(false);
  const reauth = useReauthTarget();
  const reauthAccount = useSessionStore((s) => s.accounts.find((a) => a.identityId === reauth));
  const reauthName = reauth ? accountName(reauthAccount ?? { identityId: reauth, username: null }) : null;

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
          <Wordmark size={40} />
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
              loading={walletInstalled === null}
              testID="sign-in-open-wallet"
              onPress={() => router.push('/sign-in/wallet')}
            />
          )}
          <Button
            label={copy.signin.otherDevice}
            variant="outline"
            size="block"
            testID="sign-in-other-device"
            onPress={() => router.push('/sign-in/qr')}
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
              {FEATURE_APP_CONNECT ? (
                <MethodRow
                  label={copy.signin.appConnect}
                  icon={LinkIcon}
                  disabled
                  trailing={<Tag label={copy.signin.comingSoon} />}
                  testID="sign-in-app-connect"
                />
              ) : null}
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
