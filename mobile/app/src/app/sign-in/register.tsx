import type { KeyToRegister } from '@engine/api';
import { Stack } from 'expo-router';
import { View } from 'react-native';
import { ChatBubbleLeftRightIcon, LockClosedIcon } from 'react-native-heroicons/outline';

import { copy } from '~/features/auth/copy';
import {
  cancelKeyExchange,
  checkRegistrationNow,
  continueRegistration,
  retry,
  useKeyExchange,
} from '~/features/auth/key-exchange';
import {
  CopyLinkButton,
  DevWalletUri,
  KeepAwake,
  QrCard,
  StatusBlock,
  useCancelOnBack,
  useForegroundRepoll,
  useSignedInHandoff,
  WaitingLine,
} from '~/features/auth/KeyExchangeParts';
import { useCloseSignIn } from '~/features/auth/navigation';
import { HeaderClose, SignInBody } from '~/features/auth/SignInChrome';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

/** One row per key purpose (UX_SPEC §4.5). */
function KeyList({ keys }: { keys: KeyToRegister[] }) {
  const c = useColors();
  return (
    <View className={cn('gap-3 rounded-xl p-4', tw.bgMuted)}>
      <Text variant="subheadStrong">{copy.keyreg.list}</Text>
      {keys.map((key) => {
        const auth = key.purpose === 'authentication';
        const Icon = auth ? ChatBubbleLeftRightIcon : LockClosedIcon;
        return (
          <View key={key.keyId} className="flex-row items-center gap-3">
            <Icon size={20} color={c.accent} />
            <Text variant="body" className="flex-1">
              {auth ? copy.keyreg.authKey : copy.keyreg.encryptionKey}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** UX_SPEC §4.5: the first-login `dash-st:` key registration (AUTH-06). */
export default function RegisterKeysScreen() {
  const phase = useKeyExchange((s) => s.phase);
  const mode = useKeyExchange((s) => s.mode);
  const walletOpenFailed = useKeyExchange((s) => s.walletOpenFailed);
  const close = useCloseSignIn();
  useForegroundRepoll();
  useSignedInHandoff();
  useCancelOnBack();

  const cancel = () => {
    cancelKeyExchange();
    close();
  };

  const registration = phase.name === 'registration' || phase.name === 'registering' ? phase : null;
  const confirming = phase.name === 'registering';
  const slow = phase.name === 'registering' && phase.slow;
  const qr = mode === 'qr';

  let content;
  let footer;
  if (phase.name === 'signed-in') {
    content = <StatusBlock tone="done" title={copy.signin.signedIn} testID="kx-signed-in" />;
  } else if (phase.name === 'error') {
    content = <StatusBlock tone="error" title={phase.title} body={phase.message} testID="kx-error" />;
    footer = (
      <Button
        label={copy.signin.tryAgain}
        size="block"
        testID="kx-try-again"
        onPress={() => {
          retry().catch(() => undefined);
        }}
      />
    );
  } else if (registration) {
    content = (
      <>
        <View className="gap-2">
          <Text variant="titleLarge" tone="emphasis" accessibilityRole="header">
            {copy.keyreg.title}
          </Text>
          <Text variant="body" tone="secondary">
            {copy.keyreg.body}
          </Text>
        </View>
        <KeyList keys={registration.keys} />
        {qr ? (
          <>
            <Text variant="subhead" tone="secondary" className="text-center">
              {copy.keyreg.qrHint}
            </Text>
            <QrCard value={registration.uri} testID="kx-register-qr" />
            <CopyLinkButton value={registration.uri} />
            <WaitingLine label={slow ? copy.keyreg.still : copy.signin.qrWaiting} />
          </>
        ) : null}
        {!qr && walletOpenFailed ? (
          <View className={cn('gap-3 rounded-xl p-4', tw.bgMuted)} testID="kx-nothing-opened">
            <Text variant="subhead" tone="secondary">
              {copy.signin.nothingOpened}
            </Text>
            <Button
              label={copy.signin.otherDevice}
              variant="outline"
              size="block"
              onPress={() => useKeyExchange.setState({ mode: 'qr', walletOpenFailed: false })}
            />
          </View>
        ) : null}
        {!qr && confirming ? (
          <View className="flex-row items-center gap-3 pt-2" accessibilityLiveRegion="polite" testID="kx-finishing">
            <Spinner size="sm" />
            <Text variant="subhead" tone="secondary" className="flex-1">
              {slow ? copy.keyreg.still : copy.keyreg.finishing}
            </Text>
          </View>
        ) : null}
      </>
    );
    if (slow) {
      footer = (
        <Button
          label={copy.keyreg.checkNow}
          variant={qr ? 'outline' : 'primary'}
          size="block"
          testID="kx-check-now"
          onPress={() => {
            checkRegistrationNow().catch(() => undefined);
          }}
        />
      );
    } else if (!qr && !confirming) {
      footer = (
        <Button
          label={copy.keyreg.continue}
          size="block"
          testID="kx-continue-in-wallet"
          onPress={() => {
            continueRegistration().catch(() => undefined);
          }}
        />
      );
    }
  } else {
    content = <StatusBlock tone="busy" title={copy.signin.signingIn} />;
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: '',
          headerShadowVisible: false,
          headerBackVisible: false,
          gestureEnabled: false,
          headerLeft: () => <HeaderClose onPress={cancel} />,
        }}
      />
      {qr ? <KeepAwake /> : null}
      <SignInBody footer={footer} testID="sign-in-register">
        {content}
        <DevWalletUri uri={registration?.uri ?? null} />
      </SignInBody>
    </>
  );
}
