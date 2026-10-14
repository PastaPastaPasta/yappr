import { router, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { copy } from '~/features/auth/copy';
import { WalletGlyph } from '~/features/auth/KeyExchangeParts';
import { useCloseSignIn } from '~/features/auth/navigation';
import { HeaderClose, SignInBody } from '~/features/auth/SignInChrome';
import { Button } from '~/ui/Button';
import { Text } from '~/ui/Text';

/**
 * "Renew in your wallet" (web's renew dialog): the signed-in account's
 * wallet allowance or time is running out (or ran out, and a write was
 * stopped). Approving one request in the wallet gives Yappr a fresh grant;
 * the account stays signed in. Opened by the renew prompts, Settings →
 * Wallet connection, and "Allow messaging in your wallet".
 */
export default function RenewScreen() {
  const close = useCloseSignIn();
  // Why a write was stopped, when one was (the prompt that opened this screen says).
  const { reason: param } = useLocalSearchParams<{ reason?: string }>();
  const reason = param && Object.hasOwn(copy.renew.reason, param) ? (param as keyof typeof copy.renew.reason) : null;
  return (
    <>
      <Stack.Screen
        options={{ title: '', headerShadowVisible: false, headerLeft: () => <HeaderClose onPress={close} /> }}
      />
      <SignInBody
        center
        testID="sign-in-renew"
        footer={
          <>
            <Button
              label={copy.renew.continue}
              size="block"
              onPress={() => router.push('/sign-in/connect?renew=1&mode=wallet')}
              testID="renew-wallet"
            />
            <Button
              label={copy.signin.otherDevice}
              variant="outline"
              size="block"
              onPress={() => router.push('/sign-in/connect?renew=1&mode=qr')}
              testID="renew-other-device"
            />
          </>
        }
      >
        <View className="items-center gap-3 py-6">
          <WalletGlyph pulsing={false} />
          <Text variant="titleLarge" tone="emphasis" className="text-center" accessibilityRole="header">
            {copy.renew.title}
          </Text>
          <Text variant="body" tone="secondary" className="max-w-[320px] text-center">
            {reason ? copy.renew.reason[reason] : copy.renew.body}
          </Text>
        </View>
      </SignInBody>
    </>
  );
}
