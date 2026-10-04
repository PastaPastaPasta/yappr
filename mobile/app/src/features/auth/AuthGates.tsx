import { router, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { useEngineEvent } from '~/data/events';
import { lastIdentity, useSession, useSessionStore } from '~/data/session';
import { setReauthHandler } from '~/data/session-expiry';
import { engine, engineNetworkKey } from '~/engine';
import { useEngineStatus } from '~/engine/hooks';
import { appendLog, errorMessage } from '~/engine/logs';
import { cn } from '~/lib-allowlist';
import { useInboundLinkEffects } from '~/navigation/inbound-links';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import { AccountSwitcherSheet } from './AccountSwitcher';
import { reauthenticate, recoverInterruptedAdd, returnFromAddAccount, startReauthTracking, useAccounts } from './accounts';
import { useLockState } from './app-lock';
import { AppLockOverlay } from './AppLockOverlay';
import { cancelKeyExchange, lastKeyExchangeMode, useKeyExchange } from './key-exchange';
import { setWelcomed, useOnboarding } from './onboarding';
import { useHasAcceptedTerms } from './terms';
import { TopOverlay } from './TopOverlay';

const inSignIn = (pathname: string) => pathname === '/sign-in' || pathname.startsWith('/sign-in/');

/**
 * First launch, and the first launch after the last account signed out:
 * Welcome (AUTH-01), once the navigator can take it.
 */
function useWelcomeOnFirstLaunch(ready: boolean): void {
  const checked = useRef(false);
  useEffect(() => {
    if (!ready || checked.current) return;
    checked.current = true;
    const { welcomed, welcomeDue } = useOnboarding.getState();
    // Someone signed in at the last launch (or before this build) is past Welcome. Not after the
    // last sign-out, though: that is said outright, and the provisional last identity, which the
    // engine's restore only settles later in this launch, must not hide Welcome (D-L1i-006).
    const someone = !welcomeDue && (lastIdentity() !== null || useSessionStore.getState().status === 'signed-in');
    if (!welcomed && !someone) router.push('/welcome');
  }, [ready]);
}

/**
 * A sign-in is past Welcome, however it was reached (the Profile tab, a link, Add account). Only
 * a sign-in made here counts, not a session the engine restores: a restore that still finds the
 * signed-out account for a moment must not cancel the Welcome its sign-out asked for.
 */
function useSignInPassesWelcome(): void {
  useEngineEvent('session.changed', ({ session, reason }) => {
    if (reason === 'signed-in' && session && !useOnboarding.getState().welcomed) setWelcomed(true);
  });
}

/**
 * The terms gate (AUTH-09) for a signed-in account that has not accepted
 * the current terms: right after its first sign-in here (once the sign-in
 * flow has closed), after an account switch, and at launch after a terms
 * version bump. Never over the sign-in flow or Welcome.
 */
function useTermsGate(ready: boolean, pathname: string): void {
  const { status, identityId } = useSession();
  const accepted = useHasAcceptedTerms(engineNetworkKey, identityId);
  const transition = useAccounts((s) => s.transition);
  const needsGate = ready && status === 'signed-in' && !accepted && !transition;
  const blocked = inSignIn(pathname) || pathname === '/terms-gate' || pathname === '/welcome';
  useEffect(() => {
    if (needsGate && !blocked) router.push('/terms-gate');
  }, [needsGate, blocked]);
}

/**
 * Leaving the sign-in flow by any route (a swipe-down included): abandon a
 * wallet request still waiting and forget any wallet screen state (an error
 * or a finished sign-in would greet the next visit), and after an abandoned
 * "Add account", go back to the parked account.
 */
function useSignInExit(pathname: string): void {
  const wasInSignIn = useRef(false);
  useEffect(() => {
    const inside = inSignIn(pathname);
    if (wasInSignIn.current && !inside && pathname !== '/terms-gate') {
      if (useKeyExchange.getState().phase.name !== 'idle') cancelKeyExchange();
      returnFromAddAccount();
    }
    wasInSignIn.current = inside;
  }, [pathname]);
}

/**
 * A wallet request the engine still holds after the app was killed while
 * waiting (AUTH-03): back to the waiting screen, within its 10 minutes.
 * Not when the user is already in the sign-in flow (a slow boot): the
 * request the engine holds may be the one that flow just made.
 *
 * Once per launch, it also settles an "Add account" the last launch was
 * killed in the middle of (NEW-R-vi-001): a resumed wallet request carries
 * it on, and otherwise the parked account comes back.
 */
function useResumeWalletSignIn(ready: boolean, pathname: string): void {
  const { status } = useSession();
  const { state } = useEngineStatus();
  const checked = useRef(false);
  const launchChecked = useRef(false);
  const path = useRef(pathname);
  useEffect(() => {
    path.current = pathname;
  }, [pathname]);
  const engineUp = state === 'ready' || state === 'degraded';
  useEffect(() => {
    if (!ready || !engineUp || status === 'unknown') return;
    const atLaunch = !launchChecked.current;
    launchChecked.current = true;
    const recover = (resume: boolean) => {
      if (!atLaunch) return;
      recoverInterruptedAdd({ resume }).catch((error: unknown) =>
        appendLog('warn', 'host', `Going back to the parked account failed: ${errorMessage(error)}`),
      );
    };
    if (status !== 'signed-out' || checked.current) {
      recover(false);
      return;
    }
    checked.current = true;
    const signingIn = () => inSignIn(path.current) || useKeyExchange.getState().phase.name !== 'idle';
    if (signingIn()) {
      recover(true);
      return;
    }
    engine.api.session
      .pendingKeyExchange()
      .then((pending) => {
        if (signingIn()) {
          recover(true);
          return;
        }
        if (!pending) {
          recover(false);
          return;
        }
        // The lock came up while the engine answered: try again once it opens.
        const lock = useLockState.getState();
        if (lock.locked || lock.covered) {
          checked.current = false;
          if (atLaunch) launchChecked.current = false;
          return;
        }
        recover(true);
        router.push(lastKeyExchangeMode() === 'qr' ? '/sign-in/qr?resume=1' : '/sign-in/wallet?resume=1');
      })
      .catch((error: unknown) => {
        appendLog('warn', 'host', `Reading a pending sign-in failed: ${errorMessage(error)}`);
        recover(false);
      });
  }, [ready, engineUp, status]);
}

/**
 * "Sign in again" (AUTH-14): the data layer's write controls and toasts open
 * this flow; it ends once that account is signed in again.
 */
function useReauthFlow(): void {
  useEffect(
    () =>
      setReauthHandler((id) => {
        reauthenticate(id).catch(() => undefined);
      }),
    [],
  );
  useEffect(() => startReauthTracking(), []);
}

/** Switching or adding an account restarts the engine; say so over everything until it is back. */
function AccountTransitionOverlay() {
  const transition = useAccounts((s) => s.transition);
  if (!transition) return null;
  return (
    <TopOverlay>
      <View
        className={cn('flex-1 items-center justify-center gap-4 px-8', tw.bg)}
        accessibilityViewIsModal
        testID="account-transition"
      >
        <Spinner size="lg" />
        <Text variant="headline" tone="emphasis" className="text-center" accessibilityLiveRegion="polite">
          {transition.label}
        </Text>
      </View>
    </TopOverlay>
  );
}

/**
 * The app-wide onboarding and auth gates, mounted once by the root layout:
 * Welcome on first launch, the terms gate, the wallet sign-in resume, the
 * account switcher and its progress, and the app lock.
 */
export function AuthGates() {
  // Nothing opens while the app lock is up: on iOS a modal presented over the lock screen draws
  // above it and takes touches (the terms gate's "Not now" would sign the account out).
  const lockUp = useLockState((s) => s.locked || s.covered);
  const ready = !!useRootNavigationState()?.key && !lockUp;
  const pathname = usePathname();
  useWelcomeOnFirstLaunch(ready);
  useSignInPassesWelcome();
  useTermsGate(ready, pathname);
  useSignInExit(pathname);
  useResumeWalletSignIn(ready, pathname);
  useInboundLinkEffects(ready);
  useReauthFlow();
  return (
    <>
      <AccountSwitcherSheet />
      <AccountTransitionOverlay />
      <AppLockOverlay />
    </>
  );
}
