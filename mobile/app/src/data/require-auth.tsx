import { router } from 'expo-router';
import { View } from 'react-native';
import { create } from 'zustand';

import { Button } from '~/ui/Button';
import { Sheet } from '~/ui/Sheet';
import { Text } from '~/ui/Text';

import { useSessionStore } from './session';

/** Whether the sign-in sheet is open. */
export const useSignInPrompt = create<{ open: boolean }>()(() => ({ open: false }));

/** Opens the "Sign in to continue" sheet (PRD G-8). */
export function promptSignIn(): void {
  useSignInPrompt.setState({ open: true });
}

/**
 * Runs `action` when signed in; signed out, opens the sign-in sheet instead
 * and drops the action (PRD G-8: after sign-in the user is back where they
 * were, and the action is not performed). While the engine is still
 * restoring the session, waits for the answer.
 */
export function requireAuth(action: () => void): void {
  const run = (status: string) => (status === 'signed-in' ? action() : promptSignIn());
  const { status } = useSessionStore.getState();
  if (status !== 'unknown') {
    run(status);
    return;
  }
  const stop = useSessionStore.subscribe((state) => {
    if (state.status === 'unknown') return;
    stop();
    run(state.status);
  });
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
