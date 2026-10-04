import { router } from 'expo-router';
import { View } from 'react-native';
import { create } from 'zustand';

import { engineSupervisor } from '~/engine';
import { Button } from '~/ui/Button';
import { handleOf } from '~/ui/handle';
import { Sheet } from '~/ui/Sheet';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';

import { lastIdentity, useSessionStore } from './session';
import { isSessionExpired, signInAgain } from './session-expiry';

/**
 * Whether the sign-in sheet is open; `reauth` is the account it asks to sign
 * in again (AUTH-14), null for "Sign in to continue".
 */
export const useSignInPrompt = create<{ open: boolean; reauth: string | null }>()(() => ({ open: false, reauth: null }));

/**
 * Opens the "Sign in to continue" sheet (PRD G-8), or with `reauth` the
 * "Sign in again" sheet for that account (PRD AUTH-14).
 */
export function promptSignIn(reauth: string | null = null): void {
  useSignInPrompt.setState({ open: true, reauth });
}

/** UX_SPEC §5.1 `signInPrompt.reauthBody`: "@alice", or the truncated id of an account with no name. */
function reauthBody(identityId: string, username: string | null | undefined): string {
  const name = handleOf({ id: identityId, username: username?.replace(/\.dash$/i, '') || null });
  return `Sign in again to keep posting as ${name}. You can keep browsing in the meantime.`;
}

/** UX_SPEC §6 `lockdown.writeBlocked`. */
export const LOCKDOWN_WRITE_BLOCKED = 'Unavailable in Lockdown Mode';

/**
 * Runs `action` when signed in; signed out, opens the sign-in sheet instead
 * and drops the action (PRD G-8: after sign-in the user is back where they
 * were, and the action is not performed). Before the engine has restored the
 * session, whoever was signed in last time counts (PRD G-2: a write during
 * boot is queued and shown at once); if that turns out wrong, the write is
 * refused with `NOT_SIGNED_IN`, undone, and the sheet opens. In Lockdown
 * Mode, where no engine can run, every write control says so instead (PRD
 * NET-06, UX_SPEC §4.33) and nothing changes.
 */
export function requireAuth(action: () => void): void {
  const engine = engineSupervisor.getStatus();
  if (engine.state === 'unsupported' && engine.unsupported === 'lockdown') {
    toast(LOCKDOWN_WRITE_BLOCKED);
    return;
  }
  const { status, session } = useSessionStore.getState();
  const identityId = status === 'unknown' ? lastIdentity() : (session?.identityId ?? null);
  if (identityId === null || status === 'signed-out') promptSignIn();
  // Its key no longer signs (AUTH-14): the write would only fail again.
  else if (isSessionExpired(identityId)) promptSignIn(identityId);
  else action();
}

/**
 * Gate a write control: `const requireAuth = useRequireAuth();` then
 * `onPress={() => requireAuth(() => like.run(target))}`.
 */
export function useRequireAuth(): typeof requireAuth {
  return requireAuth;
}

/**
 * The sheet `requireAuth` opens. Mounted once by the root layout; "Sign in"
 * goes to the sign-in flow (S1), and "Sign in again" to the flow for the
 * account whose key stopped working (AUTH-14).
 */
export function SignInPromptHost() {
  const open = useSignInPrompt((s) => s.open);
  const reauth = useSignInPrompt((s) => s.reauth);
  const reauthUsername = useSessionStore((s) => s.accounts.find((a) => a.identityId === reauth)?.username);
  const close = () => useSignInPrompt.setState({ open: false });
  return (
    <Sheet open={open} onClose={close} title={reauth ? 'Sign in again' : 'Sign in to continue'} testID="sign-in-prompt">
      <Text variant="body" tone="secondary">
        {reauth
          ? reauthBody(reauth, reauthUsername)
          : 'Sign in to post, like, repost and follow. You can keep browsing without an account.'}
      </Text>
      <View className="gap-2">
        <Button
          label={reauth ? 'Sign in again' : 'Sign in'}
          variant="primary"
          size="block"
          testID="sign-in-prompt-sign-in"
          onPress={() => {
            close();
            if (reauth) signInAgain(reauth);
            else router.push('/sign-in');
          }}
        />
        <Button label="Not now" variant="ghost" size="block" onPress={close} testID="sign-in-prompt-dismiss" />
      </View>
    </Sheet>
  );
}
