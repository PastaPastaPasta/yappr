import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ArrowRightStartOnRectangleIcon } from 'react-native-heroicons/outline';

import { useSession } from '~/data/session';
import { engine } from '~/engine';
import { Button } from '~/ui/Button';
import { Dialog } from '~/ui/Dialog';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { useColors } from '~/ui/tokens';

import { afterSignOut } from './accounts';
import { startAppConnectStatusSync, useAppConnectStatus } from './app-connect-status';
import { copy } from './copy';

const inSignIn = (pathname: string) => pathname === '/sign-in' || pathname.startsWith('/sign-in/');

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
  const { identityId, health, renewRequired, signedOutByWallet } = useAppConnectStatus();
  const [revoked, setRevoked] = useState<string | null>(null);
  const lastSession = useRef<string | null>(null);

  useEffect(() => startAppConnectStatusSync(), []);
  useEffect(() => {
    if (session) lastSession.current = session.identityId;
  }, [session]);

  const walletSession = session !== null && identityId === session.identityId;
  const blocked = !ready || inSignIn(pathname);

  const soonShown = useRef(false);
  useEffect(() => {
    if (!walletSession || health !== 'renew-soon' || blocked || soonShown.current) return;
    soonShown.current = true;
    toast(copy.renew.soon, { action: { label: copy.renew.soonAction, onPress: () => router.push('/sign-in/renew') } });
  }, [walletSession, health, blocked]);

  useEffect(() => {
    if (walletSession && renewRequired && !blocked) router.push('/sign-in/renew');
  }, [walletSession, renewRequired, blocked]);

  // The engine signs the account out after it reports the revoke; once that sign-out has landed,
  // what follows any sign-out here follows (the next account, or a fresh engine).
  const revokedAccount = useRef<string | null>(null);
  useEffect(() => {
    if (signedOutByWallet && revokedAccount.current === null) {
      revokedAccount.current = lastSession.current ?? '';
      setRevoked(revokedAccount.current);
      engine.api.session.appConnectDismiss({ signedOut: true }).catch(() => undefined);
    }
    if (revokedAccount.current !== null && session === null) {
      const signedOut = revokedAccount.current;
      revokedAccount.current = null;
      if (signedOut) afterSignOut(signedOut, true).catch(() => undefined);
    }
  }, [signedOutByWallet, session]);

  return (
    <Dialog open={revoked !== null && ready} onClose={() => setRevoked(null)} testID="wallet-signed-out">
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
        <Button label={copy.renew.close} variant="outline" onPress={() => setRevoked(null)} />
        <Button
          label={copy.renew.signIn}
          onPress={() => {
            setRevoked(null);
            router.push('/sign-in');
          }}
          testID="wallet-signed-out-sign-in"
        />
      </View>
    </Dialog>
  );
}
