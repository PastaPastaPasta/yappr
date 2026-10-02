import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';

import { copy } from '~/features/auth/copy';
import {
  cancelKeyExchange,
  checkAgain,
  currentWalletUri,
  openWallet,
  retry,
  startKeyExchange,
  useKeyExchange,
} from '~/features/auth/key-exchange';
import {
  DevWalletUri,
  StatusBlock,
  useCancelOnBack,
  useForegroundRepoll,
  useSignedInHandoff,
} from '~/features/auth/KeyExchangeParts';
import { links, openInApp } from '~/features/auth/onboarding';
import { useCloseSignIn } from '~/features/auth/navigation';
import { HeaderClose, SignInBody } from '~/features/auth/SignInChrome';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

/**
 * UX_SPEC §4.3: waiting for the wallet on this device (AUTH-03, AUTH-05,
 * AUTH-07). No countdown: a poll run that ends quietly becomes "Check again".
 */
export default function WalletSignInScreen() {
  const { resume } = useLocalSearchParams<{ resume?: string }>();
  const state = useKeyExchange();
  const { phase, walletOpenFailed } = state;
  const close = useCloseSignIn();
  useForegroundRepoll();
  useSignedInHandoff();
  useCancelOnBack();

  useEffect(() => {
    if (useKeyExchange.getState().phase.name === 'idle') {
      startKeyExchange('wallet', { resume: resume === '1' }).catch(() => undefined);
    }
  }, [resume]);

  // First login: the key registration step is its own screen.
  const needsRegistration = phase.name === 'registration' || phase.name === 'registering';
  useEffect(() => {
    if (needsRegistration) router.replace('/sign-in/register');
  }, [needsRegistration]);

  const cancel = () => {
    cancelKeyExchange();
    close();
  };

  const showQr = () => {
    useKeyExchange.setState({ mode: 'qr' });
    router.replace('/sign-in/qr');
  };

  let body;
  let footer;
  switch (phase.name) {
    case 'idle':
    case 'starting':
      body = <StatusBlock tone="waiting" title={copy.signin.starting} />;
      break;
    case 'waiting':
      body = walletOpenFailed ? (
        <StatusBlock tone="error" title={copy.signin.failed} testID="kx-nothing-opened">
          <View className={cn('mt-2 rounded-xl p-4', tw.bgMuted)}>
            <Text variant="subhead" tone="secondary">
              {copy.signin.nothingOpened}
            </Text>
          </View>
        </StatusBlock>
      ) : (
        <StatusBlock
          tone="waiting"
          title={copy.signin.waiting}
          body={copy.signin.waitingHint}
          testID="kx-waiting"
        />
      );
      footer = walletOpenFailed ? (
        <>
          <Button label={copy.signin.otherDevice} size="block" onPress={showQr} testID="kx-other-device" />
          <Button
            label={copy.signin.getWallet}
            variant="outline"
            size="block"
            onPress={() => openInApp(links.getWallet)}
          />
        </>
      ) : (
        <Button
          label={copy.signin.openAgain}
          variant="outline"
          size="block"
          onPress={openWallet}
          testID="kx-open-again"
        />
      );
      break;
    case 'no-response':
      body = (
        <StatusBlock
          tone="waiting"
          title={copy.signin.noResponse}
          body={copy.signin.noResponseHint}
          testID="kx-no-response"
        />
      );
      footer = (
        <>
          <Button
            label={copy.signin.checkAgain}
            size="block"
            testID="kx-check-again"
            onPress={() => {
              checkAgain().catch(() => undefined);
            }}
          />
          <Button label={copy.signin.cancel} variant="ghost" size="block" onPress={cancel} />
        </>
      );
      break;
    case 'error':
      body = <StatusBlock tone="error" title={phase.title} body={phase.message} testID="kx-error" />;
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
      break;
    case 'signed-in':
      body = <StatusBlock tone="done" title={copy.signin.signedIn} testID="kx-signed-in" />;
      break;
    default:
      body = <StatusBlock tone="busy" title={copy.signin.signingIn} />;
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
      <SignInBody center footer={footer} testID="sign-in-wallet">
        {body}
        <DevWalletUri uri={currentWalletUri(state)} />
      </SignInBody>
    </>
  );
}
