import { router } from 'expo-router';
import { View } from 'react-native';
import { create } from 'zustand';

import { engineSupervisor } from '~/engine';
import { Button } from '~/ui/Button';
import { Sheet } from '~/ui/Sheet';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';

import { lastIdentity, useSessionStore } from './session';

/** Whether the sign-in sheet is open. */
export const useSignInPrompt = create<{ open: boolean }>()(() => ({ open: false }));

/** Opens the "Sign in to continue" sheet (PRD G-8). */
export function promptSignIn(): void {
  useSignInPrompt.setState({ open: true });
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
  const { status } = useSessionStore.getState();
  const signedIn = status === 'unknown' ? lastIdentity() !== null : status === 'signed-in';
  if (signedIn) action();
  else promptSignIn();
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
 * goes to the sign-in flow (S1).
 */
export function SignInPromptHost() {
  const open = useSignInPrompt((s) => s.open);
  const close = () => useSignInPrompt.setState({ open: false });
  return (
    <Sheet open={open} onClose={close} title="Sign in to continue" testID="sign-in-prompt">
      <Text variant="body" tone="secondary">
        Sign in to post, like, repost and follow. You can keep browsing without an account.
      </Text>
      <View className="gap-2">
        <Button
          label="Sign in"
          variant="primary"
          size="block"
          testID="sign-in-prompt-sign-in"
          onPress={() => {
            close();
            router.push('/sign-in');
          }}
        />
        <Button label="Not now" variant="ghost" size="block" onPress={close} testID="sign-in-prompt-dismiss" />
      </View>
    </Sheet>
  );
}
