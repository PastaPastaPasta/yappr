import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { ArrowRightStartOnRectangleIcon } from 'react-native-heroicons/outline';

import { useSession } from '~/data/session';
import { engine } from '~/engine';
import { Button } from '~/ui/Button';
import { Dialog } from '~/ui/Dialog';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { useColors } from '~/ui/tokens';

import { reauthenticate } from './accounts';
import { startAppConnectStatusSync, useAppConnectStatus, useRevokedNotice } from './app-connect-status';
import { copy } from './copy';
import { inSignIn } from './navigation';

/**
 * The App Connect session's prompts (web's `AppConnectSessionNotices`),
 * mounted once by `AuthGates`:
 * - a toast with "Renew" when the allowance or the time left runs low (once per launch);
 * - "Renew in your wallet" when a write was stopped for the allowance or the expiry;
 * - "Signed out from your wallet" when the wallet revoked this phone's keys.
 */
export function AppConnectNotices({ ready }: { ready: boolean }) {
  const c = useColors();
  const pathname = usePathname();
  const { session } = useSession();
  const { identityId, health, renewRequired } = useAppConnectStatus();
  const revoked = useRevokedNotice((s) => s.account);
  const dismiss = () => useRevokedNotice.setState({ account: null });

  useEffect(() => startAppConnectStatusSync(), []);

  const walletSession = session !== null && identityId === session.identityId;
  const blocked = !ready || inSignIn(pathname);

  const soonShown = useRef(false);
  useEffect(() => {
    if (!walletSession || health !== 'renew-soon' || blocked || soonShown.current) return;
    soonShown.current = true;
    toast(copy.renew.soon, { action: { label: copy.renew.soonAction, onPress: () => router.push('/sign-in/renew') } });
  }, [walletSession, health, blocked]);

  // A write stopped for the allowance or the expiry: the prompt opens once per stop. It is handled
  // here as it opens, and re-armed only once the engine has forgotten the stop (closing the prompt
  // before the engine's answer, or a dismissal that failed, must not open it again).
  const prompted = useRef(false);
  useEffect(() => {
    if (!renewRequired) prompted.current = false;
  }, [renewRequired]);
  useEffect(() => {
    if (!walletSession || !renewRequired || blocked || prompted.current) return;
    prompted.current = true;
    engine.api.session.appConnectDismiss({ renewRequired: true }).catch(() => undefined);
    router.push(`/sign-in/renew?reason=${renewRequired}`);
  }, [walletSession, renewRequired, blocked]);

  return (
    <Dialog open={revoked !== null && ready} onClose={dismiss} testID="wallet-signed-out">
      <View className="gap-2">
        <ArrowRightStartOnRectangleIcon size={28} color={c.accent} />
        <Text variant="headline" tone="emphasis" accessibilityRole="header">
          {copy.renew.signedOutTitle}
        </Text>
        <Text variant="subhead" tone="secondary">
          {copy.renew.signedOutBody}
        </Text>
      </View>
      <View className="mt-6 flex-row flex-wrap justify-end gap-3">
        <Button label={copy.renew.close} variant="outline" onPress={dismiss} />
        <Button
          label={copy.renew.signIn}
          onPress={() => {
            const account = revoked;
            dismiss();
            if (account) reauthenticate(account).catch(() => undefined);
          }}
          testID="wallet-signed-out-sign-in"
        />
      </View>
    </Dialog>
  );
}
