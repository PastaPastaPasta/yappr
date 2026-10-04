import { router, Stack, useLocalSearchParams, useNavigation, useRoute } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';

import { copy } from '~/features/auth/copy';
import { cancelKeyExchange, checkAgain, retry, startKeyExchange, useKeyExchange } from '~/features/auth/key-exchange';
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
import { Button } from '~/ui/Button';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';

/** UX_SPEC §4.4: the request as a QR code for a wallet on another device (AUTH-04). */
export default function QrSignInScreen() {
  const { resume } = useLocalSearchParams<{ resume?: string }>();
  const phase = useKeyExchange((s) => s.phase);
  const request = useKeyExchange((s) => s.request);
  useForegroundRepoll();
  useSignedInHandoff();
  useCancelOnBack();
  const close = useCloseSignIn();
  const navigation = useNavigation();
  const { key } = useRoute();
  // Reopened by a relaunch (AUTH-03 resume), this screen is the sign-in flow's first and has no Back:
  // it gets the flow's Cancel, which closes it as the swipe-down does (an abandoned "Add account" goes
  // back to the previous account).
  const first = navigation.getState()?.routes[0]?.key === key;

  useEffect(() => {
    const current = useKeyExchange.getState();
    if (current.phase.name === 'idle') startKeyExchange('qr', { resume: resume === '1' }).catch(() => undefined);
    else useKeyExchange.setState({ mode: 'qr' });
  }, [resume]);

  const needsRegistration = phase.name === 'registration' || phase.name === 'registering';
  useEffect(() => {
    if (needsRegistration) router.replace('/sign-in/register');
  }, [needsRegistration]);

  const uri = request?.uri ?? null;
  let status;
  let footer;
  switch (phase.name) {
    case 'waiting':
      status = <WaitingLine />;
      break;
    case 'no-response':
      status = (
        <View className="items-center gap-1" testID="kx-no-response">
          <Text variant="bodyStrong" tone="emphasis" className="text-center">
            {copy.signin.noResponse}
          </Text>
          <Text variant="subhead" tone="secondary" className="text-center">
            {copy.signin.noResponseHint}
          </Text>
        </View>
      );
      footer = (
        <Button
          label={copy.signin.checkAgain}
          size="block"
          testID="kx-check-again"
          onPress={() => {
            checkAgain().catch(() => undefined);
          }}
        />
      );
      break;
    case 'error':
      status = null;
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
    default:
      status = null;
  }

  let content;
  if (phase.name === 'error') {
    content = <StatusBlock tone="error" title={phase.title} body={phase.message} testID="kx-error" />;
  } else if (phase.name === 'signed-in') {
    content = <StatusBlock tone="done" title={copy.signin.signedIn} testID="kx-signed-in" />;
  } else {
    content = (
      <>
        <View className="gap-2">
          <Text variant="titleLarge" tone="emphasis" accessibilityRole="header">
            {copy.signin.qrTitle}
          </Text>
          <Text variant="body" tone="secondary">
            {copy.signin.qrHint}
          </Text>
        </View>
        {uri && phase.name !== 'starting' ? (
          <QrCard value={uri} dimmed={phase.name === 'no-response'} testID="kx-qr" />
        ) : (
          <View className="h-[274px] items-center justify-center">
            <Spinner />
          </View>
        )}
        {uri ? <CopyLinkButton value={uri} /> : null}
        {status}
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: '',
          headerShadowVisible: false,
          headerLeft: first
            ? () => (
                <HeaderClose
                  onPress={() => {
                    cancelKeyExchange();
                    close();
                  }}
                />
              )
            : undefined,
        }}
      />
      <KeepAwake />
      <SignInBody footer={footer} testID="sign-in-qr">
        {content}
        <DevWalletUri uri={uri} />
      </SignInBody>
    </>
  );
}
