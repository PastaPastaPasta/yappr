import type { DmSetupResult } from '@engine/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, View } from 'react-native';

import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { CopyLinkButton, DevWalletUri, QrCard, WaitingLine } from '~/features/auth/KeyExchangeParts';
import { Button } from '~/ui/Button';
import { Text } from '~/ui/Text';

import { readErrorMessage } from './dm-data';

/** How often the app checks whether the wallet's approval has landed. */
const CHECK_MS = 5_000;
/** Checking stops quietly after this long (a sign-in request's lifetime); "Check now" still works. */
const CHECK_FOR_MS = 10 * 60_000;
const SETUP_FAILED = "Couldn't set up messaging. Try again.";

type Approval = { uri: string; qr: boolean };

/**
 * "Set up messaging" for an account with no messaging key yet (App Connect
 * builds): the wallet approves `dm.setUpMessaging`'s link, on this device or
 * by QR code on another. Then `dm.unlock` is checked every 5 s and on return
 * from the wallet until the key lands. While waiting, an answer other than
 * "unlocked" means "not yet": a node one block behind can still miss the
 * new key. Only setup's own answer can say the account has another key
 * (`onOtherKey`: paste it).
 */
export function MessagingSetup({ onUnlocked, onOtherKey }: { onUnlocked: () => void; onOtherKey: () => void }) {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Unmounted (the sheet closed): a late answer must not toast or refresh.
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const openWallet = useCallback((uri: string) => {
    Linking.openURL(uri).catch((e: unknown) => {
      appendLog('info', 'host', `No app opened the wallet link: ${errorMessage(e)}`);
      // No wallet on this device: the code, for one on another.
      setApproval({ uri, qr: true });
    });
  }, []);

  const check = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    engine.api.dm
      .unlock({})
      .then((result) => {
        if (alive.current && result.unlocked) onUnlocked();
      })
      .catch((e: unknown) => appendLog('info', 'host', `Messaging setup check failed: ${errorMessage(e)}`))
      .finally(() => {
        inFlight.current = false;
        setChecking(false);
      });
  }, [onUnlocked]);

  // Keyed on there being a link, not on how it shows: switching to the QR code keeps the schedule.
  const waiting = approval !== null;
  useEffect(() => {
    if (!waiting) return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > CHECK_FOR_MS) clearInterval(timer);
      else check();
    }, CHECK_MS);
    const back = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => {
      clearInterval(timer);
      back.remove();
    };
  }, [waiting, check]);

  /** A fresh link each time: an earlier one goes stale once the identity changes. */
  const start = (qr: boolean) => {
    setStarting(true);
    setError(null);
    engine.api.dm
      .setUpMessaging()
      .then((result: DmSetupResult) => {
        if (!alive.current) return;
        if (result.unlocked) onUnlocked();
        else if (result.reason === 'approve-in-wallet') {
          setApproval({ uri: result.uri, qr });
          if (!qr) openWallet(result.uri);
        } else if (result.reason === 'not-derivable') onOtherKey();
        else setError(SETUP_FAILED);
      })
      .catch((e: unknown) => setError(readErrorMessage(e) ?? SETUP_FAILED))
      .finally(() => setStarting(false));
  };

  const errorLine = error ? (
    <Text variant="caption" tone="error" accessibilityLiveRegion="polite" testID="dm-setup-error">
      {error}
    </Text>
  ) : null;

  if (!approval) {
    return (
      <View className="gap-3 pb-2" testID="dm-setup">
        <Text variant="body" tone="secondary">
          Approve one request in your Dash wallet to start sending and reading private messages. You only do this
          once.
        </Text>
        {errorLine}
        <Button
          label="Continue in wallet"
          size="block"
          loading={starting}
          onPress={() => start(false)}
          testID="dm-setup-wallet"
        />
        <Button
          label="Use a wallet on another device"
          variant="outline"
          size="block"
          disabled={starting}
          onPress={() => start(true)}
          testID="dm-setup-other-device"
        />
      </View>
    );
  }

  return (
    <View className="gap-3 pb-2" testID="dm-setup-waiting">
      <Text variant="body" tone="secondary">
        {approval.qr
          ? 'Scan this code with the wallet you sign in with.'
          : 'Approve the request in your wallet, then come back here.'}
      </Text>
      {approval.qr ? (
        <>
          <QrCard value={approval.uri} label="Messaging setup QR code" testID="dm-setup-qr" />
          <CopyLinkButton value={approval.uri} />
        </>
      ) : null}
      <WaitingLine label="Waiting for your wallet…" />
      {errorLine}
      <Button
        label="Check now"
        variant={approval.qr ? 'outline' : 'primary'}
        size="block"
        loading={checking}
        onPress={check}
        testID="dm-setup-check"
      />
      {approval.qr ? null : (
        <Button
          label="Open wallet again"
          variant="outline"
          size="block"
          loading={starting}
          onPress={() => start(false)}
          testID="dm-setup-open"
        />
      )}
      <DevWalletUri uri={approval.uri} />
    </View>
  );
}
