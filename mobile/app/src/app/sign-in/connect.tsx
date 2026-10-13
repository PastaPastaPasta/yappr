import type { AppConnectCandidateDTO } from '@engine/api';
import { Stack, useLocalSearchParams, useNavigation, useRoute } from 'expo-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { AppState, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import {
  acceptAccount,
  cancelAppConnect,
  checkAgain,
  notMe,
  openWallet,
  pollNow,
  resetAppConnect,
  startAppConnect,
  switchToQr,
  useAppConnect,
} from '~/features/auth/app-connect';
import { copy } from '~/features/auth/copy';
import { CopyLinkButton, DevWalletUri, KeepAwake, QrCard, StatusBlock, WaitingLine } from '~/features/auth/KeyExchangeParts';
import { links, openInApp } from '~/features/auth/onboarding';
import { useCloseSignIn } from '~/features/auth/navigation';
import { HeaderClose, SignInBody } from '~/features/auth/SignInChrome';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { handleOf } from '~/ui/handle';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

/** One account that answered: avatar, name and handle, and "Continue as @alice". */
function AccountCard({ candidate, testID }: { candidate: AppConnectCandidateDTO; testID: string }) {
  const { identityId } = candidate;
  const profile = useEngineQuery(queryKeys.profile.detail(identityId), (api) => api.profiles.get(identityId));
  const username = profile.data?.username ?? candidate.username?.replace(/\.dash$/i, '') ?? null;
  const handle = handleOf({ id: identityId, username });
  const name = profile.data?.displayName || handle;
  return (
    <View className={cn('items-center gap-3 rounded-2xl border p-5', tw.border)} testID={`${testID}-card`}>
      <Avatar avatar={profile.data?.avatar} identityId={identityId} size="xl" />
      <View className="items-center gap-0.5">
        <Text variant="headline" tone="emphasis" numberOfLines={1}>
          {name}
        </Text>
        {name === handle ? null : (
          <Text variant="subhead" tone="secondary" numberOfLines={1}>
            {handle}
          </Text>
        )}
      </View>
      <Button
        label={copy.connect.continueAs(handle)}
        size="block"
        onPress={() => {
          acceptAccount(identityId).catch(() => undefined);
        }}
        testID={testID}
      />
    </View>
  );
}

/** Poll at once whenever the app comes back to the foreground: the user may have just approved. */
function useForegroundPoll(): void {
  const last = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const previous = last.current;
      last.current = state;
      if (state === 'active' && previous !== 'active') pollNow();
    });
    return () => subscription.remove();
  }, []);
}

/**
 * Wallet sign-in on App Connect builds (UX_SPEC §4.3/§4.4 states; web's App
 * Connect panel): the request opens the wallet on this device (`mode=wallet`)
 * or shows as a QR code for a wallet on another device (`mode=qr`). Each
 * answer is verified on chain, then the user says which account is theirs
 * before anything is stored. `renew=1` renews the signed-in account: only it
 * may answer, and it is accepted without asking. No countdown is ever shown.
 */
export default function ConnectScreen() {
  const params = useLocalSearchParams<{ mode?: string; renew?: string; resume?: string }>();
  const renew = params.renew === '1';
  const { mode, step, flow, walletOpenFailed, rejected } = useAppConnect();
  const close = useCloseSignIn();
  const navigation = useNavigation();
  const { key } = useRoute();
  const first = navigation.getState()?.routes[0]?.key === key;
  useForegroundPoll();

  useEffect(() => {
    startAppConnect(params.mode === 'qr' ? 'qr' : 'wallet', { renew, resume: params.resume === '1' }).catch(() => undefined);
    // Leaving the screen any way but by finishing abandons the request.
    return () => {
      if (useAppConnect.getState().step.name !== 'done') cancelAppConnect();
    };
  }, [params.mode, params.resume, renew]);

  // Signed in (or renewed): "Signed in" for a moment, then back where the user was (or the terms gate).
  const done = step.name === 'done';
  useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(() => {
      resetAppConnect();
      close();
    }, 900);
    return () => clearTimeout(timer);
  }, [done, close]);

  // A renewal names its account, so its one verified answer is accepted without asking.
  const renewalAnswer = renew && step.name === 'flow' && flow?.phase === 'confirm' ? flow.candidates[0]?.identityId : undefined;
  useEffect(() => {
    if (renewalAnswer) acceptAccount(renewalAnswer).catch(() => undefined);
  }, [renewalAnswer]);

  const cancel = () => {
    cancelAppConnect();
    close();
  };
  const startOver = () => {
    startAppConnect(mode, { renew, fresh: true }).catch(() => undefined);
  };

  let body: ReactNode;
  let footer: ReactNode = null;
  const uri = flow && 'uri' in flow ? flow.uri : null;

  if (step.name === 'idle' || step.name === 'starting' || (step.name === 'flow' && flow?.phase === 'checking')) {
    body = <StatusBlock tone="busy" title={copy.signin.starting} />;
  } else if (step.name === 'accepting' || renewalAnswer) {
    body = <StatusBlock tone="busy" title={renew ? copy.renew.renewing : copy.signin.signingIn} />;
  } else if (step.name === 'done') {
    body = <StatusBlock tone="done" title={renew ? copy.renew.renewed : copy.signin.signedIn} testID="kx-signed-in" />;
  } else if (step.name === 'error') {
    body = <StatusBlock tone="error" title={step.title} body={step.message} testID="kx-error" />;
    footer = <Button label={copy.signin.tryAgain} size="block" onPress={startOver} testID="kx-try-again" />;
  } else if (flow?.phase === 'unavailable') {
    const text = copy.connect.unavailable[flow.reason];
    body = <StatusBlock tone="error" title={text.title} body={text.body} testID="ac-unavailable" />;
    if (flow.reason === 'offline' || flow.reason === 'storage') {
      footer = <Button label={copy.signin.tryAgain} size="block" onPress={startOver} testID="kx-try-again" />;
    }
  } else if (flow?.phase === 'too-many') {
    body = <StatusBlock tone="waiting" title={copy.connect.tooManyTitle} body={copy.connect.tooManyBody} testID="ac-too-many" />;
    footer = <Button label={copy.connect.startAgain} size="block" onPress={startOver} testID="ac-start-again" />;
  } else if (flow?.phase === 'timeout') {
    body = <StatusBlock tone="waiting" title={copy.signin.noResponse} body={copy.signin.noResponseHint} testID="kx-no-response" />;
    footer = (
      <>
        <Button
          label={copy.signin.checkAgain}
          size="block"
          onPress={() => {
            checkAgain().catch(() => undefined);
          }}
          testID="kx-check-again"
        />
        <Button label={copy.signin.cancel} variant="ghost" size="block" onPress={cancel} />
      </>
    );
  } else if (flow?.phase === 'confirm') {
    const several = flow.candidates.length > 1;
    body = (
      <View className="gap-4" testID={several ? 'ac-chooser' : 'ac-confirm'}>
        <View className="gap-1">
          <Text variant="titleLarge" tone="emphasis" accessibilityRole="header">
            {several ? copy.connect.chooseTitle : copy.connect.confirmTitle}
          </Text>
          <Text variant="body" tone="secondary">
            {several ? copy.connect.chooseBody : copy.connect.confirmBody}
          </Text>
        </View>
        {flow.candidates.map((candidate, index) => (
          <AccountCard
            key={candidate.identityId}
            candidate={candidate}
            testID={several ? `ac-continue-${index}` : 'ac-continue'}
          />
        ))}
      </View>
    );
    footer = (
      <Button
        label={several ? copy.connect.noneOfThese : copy.connect.notMe}
        variant="ghost"
        size="block"
        onPress={() => {
          notMe().catch(() => undefined);
        }}
        testID="ac-not-me"
      />
    );
  } else if (mode === 'qr') {
    body = (
      <>
        <View className="gap-2">
          <Text variant="titleLarge" tone="emphasis" accessibilityRole="header">
            {renew ? copy.renew.title : copy.signin.qrTitle}
          </Text>
          <Text variant="body" tone="secondary">
            {copy.signin.qrHint}
          </Text>
        </View>
        {rejected ? <Notice text={copy.connect.newCode} /> : null}
        {uri ? <QrCard value={uri} testID="kx-qr" /> : null}
        {uri ? <CopyLinkButton value={uri} /> : null}
        <WaitingLine />
        <KeepAwake />
      </>
    );
  } else {
    body = walletOpenFailed ? (
      <StatusBlock tone="waiting" title={copy.signin.waiting} testID="kx-nothing-opened">
        <View className={cn('mt-2 rounded-xl p-4', tw.bgMuted)}>
          <Text variant="subhead" tone="secondary">
            {copy.signin.nothingOpened}
          </Text>
        </View>
      </StatusBlock>
    ) : (
      <StatusBlock tone="waiting" title={copy.signin.waiting} body={copy.signin.waitingHint} testID="kx-waiting">
        {rejected ? <Notice text={copy.connect.newCode} /> : null}
      </StatusBlock>
    );
    footer = walletOpenFailed ? (
      <>
        <Button label={copy.signin.otherDevice} size="block" onPress={switchToQr} testID="kx-other-device" />
        <Button label={copy.signin.getWallet} variant="outline" size="block" onPress={() => openInApp(links.getWallet)} />
      </>
    ) : (
      <>
        <Button label={copy.signin.openAgain} variant="outline" size="block" onPress={openWallet} testID="kx-open-again" />
        <Button label={copy.signin.otherDevice} variant="ghost" size="block" onPress={switchToQr} testID="kx-other-device" />
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: '',
          headerShadowVisible: false,
          headerBackVisible: !first,
          headerLeft: first ? () => <HeaderClose onPress={cancel} /> : undefined,
        }}
      />
      <SignInBody center={mode !== 'qr' || step.name !== 'flow'} footer={footer} testID="sign-in-connect">
        {body}
        <DevWalletUri uri={step.name === 'flow' ? uri : null} />
      </SignInBody>
    </>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <View className="mt-2 rounded-xl bg-amber-50 p-3 dark:bg-amber-900/20" accessibilityLiveRegion="polite">
      <Text variant="subhead" className="text-amber-800 dark:text-amber-200">
        {text}
      </Text>
    </View>
  );
}
