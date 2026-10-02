import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { XMarkIcon } from 'react-native-heroicons/outline';

import { useSession } from '~/data/session';
import { errorCode } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { IconButton } from '~/ui/IconButton';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';

import { openConversationScreen } from './dm-actions';
import { readErrorMessage, useDmViewer } from './dm-data';
import { DmSignedOut } from './DmStates';
import { UserPicker } from './UserPicker';

/** Closes the modal and opens the conversation on the Messages tab. */
export function leaveModalFor(key: string): void {
  if (router.canDismiss()) router.dismiss();
  openConversationScreen(key);
}

export function CloseButton() {
  return (
    <IconButton
      icon={XMarkIcon}
      accessibilityLabel="Close"
      onPress={() => {
        if (router.canGoBack()) router.back();
      }}
      testID="modal-close"
    />
  );
}

function startFailedMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'BAD_REQUEST':
      return errorMessage(error).includes('yourself') ? "You can't message yourself" : 'No user found with this identity ID';
    case 'NO_KEY':
      return 'Unlock your messages first.';
    default:
      return readErrorMessage(error) ?? 'Failed to start conversation';
  }
}

/** How long a start waits for v5's saved state to load (the same budget as the reads' `ENGINE_BUSY` retries). */
export const START_WAIT_MS = 60_000;

/**
 * `dm.startDirect`, waiting out `ENGINE_BUSY` (v5's saved state still loading:
 * a cold start from a link, or recovery). Any other error, or still busy after
 * `START_WAIT_MS`, rejects. Null when the screen went away meanwhile.
 */
export async function startDirectWhenReady(peerId: string, alive: () => boolean): Promise<string | null> {
  const deadline = Date.now() + START_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const key = await engine.api.dm.startDirect(peerId);
      return alive() ? key : null;
    } catch (error) {
      if (errorCode(error) !== 'ENGINE_BUSY' || Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 4000)));
    if (!alive()) return null;
  }
}

/**
 * New message (UX_SPEC §4.21, PRD DM-05): pick a person, then the existing
 * or a new 1:1 opens (`dm.startDirect`, which writes nothing). Opened with
 * `?with=<id>` (a profile's Message button, `startConversation` links) it
 * opens that person's conversation straight away.
 */
export function NewMessageScreen() {
  const { with: recipient } = useLocalSearchParams<{ with?: string }>();
  const { signedIn, viewerId } = useDmViewer();
  const restored = useSession().status === 'signed-in';
  const [opening, setOpening] = useState<string | null>(null);
  const tried = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = (peerId: string) => {
    if (opening) return;
    if (peerId === viewerId) {
      toast.error("You can't message yourself");
      return;
    }
    setOpening(peerId);
    startDirectWhenReady(peerId, () => mounted.current)
      .then((key) => {
        if (key) leaveModalFor(key);
      })
      .catch((error: unknown) => {
        appendLog('info', 'host', `dm.startDirect failed: ${errorMessage(error)}`);
        if (!mounted.current) return;
        toast.error(startFailedMessage(error));
        setOpening(null);
      });
  };

  useEffect(() => {
    // After the engine restores the session (a link can cold-start the app).
    if (!recipient || !restored || tried.current) return;
    tried.current = true;
    start(recipient);
    // Once per opening: a failure leaves the picker, showing that person, for the user.
  });

  const header = (
    <Stack.Screen options={{ title: 'New message', headerLeft: () => <CloseButton /> }} />
  );

  if (!signedIn || !viewerId) {
    return (
      <Screen>
        {header}
        <DmSignedOut />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentInsetAdjustmentBehavior="automatic">
        <Text variant="subhead" tone="secondary" className="px-4 pb-2 pt-3">
          Choose a person to start an encrypted conversation.
        </Text>
        <UserPicker
          viewerId={viewerId}
          onPick={(user) => start(user.id)}
          autoFocus={!recipient}
          initialQuery={recipient ?? ''}
        />
      </ScrollView>
      {opening ? (
        <View
          className="absolute inset-0 items-center justify-center gap-3 bg-white/60 dark:bg-black/50"
          accessibilityLiveRegion="polite"
          testID="new-message-opening"
        >
          <Spinner size="md" />
          <Text variant="subhead" tone="secondary">
            Opening the conversation…
          </Text>
        </View>
      ) : null}
    </Screen>
  );
}
