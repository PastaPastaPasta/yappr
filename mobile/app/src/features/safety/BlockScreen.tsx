import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { NoSymbolIcon, UserIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useCapabilities, useSession } from '~/data/session';
import { recheckWrite, useWrite } from '~/data/writes';
import { errorMessage } from '~/engine/logs';
import { useDmStatus } from '~/features/messages/dm-data';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { mediumImpact } from '~/ui/haptics';
import { LinkText } from '~/ui/LinkText';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { monoFont, useColors } from '~/ui/tokens';

import { blockWrite, useAuthorBlocked, useBlockBusy, useBlockTicket } from './block-state';
import { findCachedUser } from './cached';
import { copy } from './copy';
import { SheetBody, SheetHeading, SheetLoading, SheetMessage, closeSheet, signInAction } from './SafetySheet';

/** `block.message` (`safety.block` refuses more). */
export const BLOCK_NOTE_MAX = 280;

/**
 * Block or unblock an account (PRD SAFE-01, SAFE-02; UX_SPEC §4.39), from a
 * post's, profile's or conversation's menu. A block is a public, paid
 * document, so it asks first, with an optional public note behind "Add a
 * note". On "Block" the account's posts leave every list at once, and the
 * sheet stays, its button "Blocking…", until the block is confirmed: then
 * it closes with "Blocked @x" (on DM v5 Messages block them too). One not
 * confirmed yet says so, with "Check again"; one that fails brings
 * everything back and says so. Closed meanwhile, the block goes on, and
 * the toast still follows it. An account already blocked offers "Unblock".
 */
export function BlockScreen() {
  const { userId = '' } = useLocalSearchParams<{ userId?: string }>();
  const { status, identityId: viewerId } = useSession();
  const signedIn = status === 'signed-in' && viewerId !== null;
  const self = signedIn && viewerId === userId;
  const seed = useMemo(() => findCachedUser(userId), [userId]);
  const profile = useEngineQuery(queryKeys.profile.detail(userId), (api) => api.profiles.get(userId), {
    enabled: signedIn && !self && userId !== '',
    persist: true,
  });
  const blocked = useAuthorBlocked(userId, profile.data?.viewer?.blocks);
  // A block or unblock still on its way: the button says so, and the opposite action waits for it.
  const busy = useBlockBusy(userId);
  const write = useWrite(blockWrite);
  // Not confirmed yet, and no check has proved it absent: the app checks it, and says so.
  const landing = useBlockTicket(userId);
  const unconfirmed = landing?.state === 'unconfirmed';
  const [checking, setChecking] = useState(false);
  // Confirmed: done (the toast says so, `blockWrite.onConfirmed`).
  useEffect(() => {
    if (write.status === 'confirmed') closeSheet();
  }, [write.status]);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const c = useColors();
  const dm = useCapabilities()?.dm ?? null;
  // On DM v5 the Block reaches Messages on this device once they are unlocked here (until then the engine
  // keeps it for later), so only then does the body promise they can't message you (SAFE-01).
  const dmStatus = useDmStatus(signedIn && !self && dm === 'v5');
  const bodyFor = dm === 'v5' && dmStatus.data?.locked !== false ? null : dm;
  const reading = profile.isPending || (dm === 'v5' && dmStatus.isPending);

  const title = blocked ? 'Blocked account' : 'Block account';
  const header = <Stack.Screen options={{ title }} />;

  if (status === 'unknown') return <SheetLoading testID="block-loading" />;
  if (!signedIn) {
    return (
      <>
        {header}
        <SheetMessage title={copy.block.signIn} icon={NoSymbolIcon} action={signInAction} testID="block-signed-out" />
      </>
    );
  }
  if (self) {
    return (
      <>
        {header}
        <SheetMessage title={copy.block.self} icon={NoSymbolIcon} testID="block-self" />
      </>
    );
  }
  // A cached name and avatar paint the sheet at once; the actions wait for the block status.
  if (profile.isPending && !seed) return <SheetLoading testID="block-loading" />;
  // A failed refetch keeps the profile it had (a persisted one, offline): only an empty read is an error.
  if ((profile.isError && !profile.data) || profile.data === null) {
    return (
      <>
        {header}
        <View className="flex-1 bg-white dark:bg-neutral-900">
          <ErrorState
            message={profile.isError ? errorMessage(profile.error) : copy.block.loadFailed}
            onRetry={() => {
              profile.refetch().catch(() => undefined);
            }}
            retrying={profile.isRetrying}
            testID="block-error"
          />
        </View>
      </>
    );
  }

  const user = profile.data ?? seed;
  const handle = user ? handleOf(user) : 'this account';
  const ownViewerId = viewerId;

  const block = () => {
    mediumImpact();
    const message = note.trim();
    const row = user ? { username: user.username, displayName: user.displayName, avatar: user.avatar } : undefined;
    write.send({ viewerId: ownViewerId, userId, block: true, message: message || undefined, user: row, handle }).catch(() => undefined);
  };
  const unblock = () => {
    write.send({ viewerId: ownViewerId, userId, block: false, handle }).catch(() => undefined);
  };
  const checkAgain = () => {
    if (!landing || checking) return;
    setChecking(true);
    recheckWrite(landing.id)
      .catch(() => null)
      .finally(() => setChecking(false));
  };
  // While a write may still land, the sheet shows what it asks for as not done yet: "Block @x?" with "Blocking…".
  const shownBlocked = busy === 'blocking' ? false : busy === 'unblocking' ? true : blocked;
  const busyLabel = busy === 'blocking' ? copy.block.blocking : busy === 'unblocking' ? copy.block.unblocking : null;

  return (
    <>
      {header}
      <SheetBody testID="block-sheet">
        {user ? (
          <View className="flex-row items-center gap-3" accessible accessibilityLabel={`${user.displayName}, ${handle}`}>
            <Avatar avatar={user.avatar} identityId={user.id} size="md" />
            <View className="flex-1">
              <Text variant="bodyStrong" numberOfLines={1}>
                {user.displayName}
              </Text>
              <Text variant="subhead" tone="secondary" numberOfLines={1} style={user.username ? undefined : monoFont}>
                {handle}
              </Text>
            </View>
          </View>
        ) : null}
        {reading ? (
          <View className="items-center py-6" testID="block-loading">
            <Spinner />
          </View>
        ) : shownBlocked ? (
          <>
            <SheetHeading icon={NoSymbolIcon} iconColor={c.destructive} title={copy.block.blockedTitle(handle)} body={copy.block.blockedBody} />
            <Button
              label={busyLabel ?? copy.block.unblock}
              size="block"
              icon={UserIcon}
              accessibilityLabel={busy ? undefined : `Unblock ${handle}`}
              disabled={busy !== null}
              onPress={unblock}
              testID="unblock-confirm"
            />
          </>
        ) : (
          <>
            <SheetHeading icon={NoSymbolIcon} iconColor={c.destructive} title={copy.block.title(handle)} body={copy.block.body(bodyFor)} />
            {busy ? null : noteOpen ? (
              <View className="gap-1">
                <TextField
                  label={copy.block.note}
                  value={note}
                  onChangeText={setNote}
                  maxLength={BLOCK_NOTE_MAX}
                  multiline
                  autoFocus
                  testID="block-note"
                />
                <Text variant="caption" tone="secondary">
                  {copy.block.noteHint}
                </Text>
              </View>
            ) : (
              <LinkText
                label={copy.block.addNote}
                role="button"
                className="self-start"
                onPress={() => setNoteOpen(true)}
                testID="block-add-note"
              />
            )}
            <Button
              label={busyLabel ?? copy.block.confirm}
              variant="destructive"
              size="block"
              icon={NoSymbolIcon}
              accessibilityLabel={busy ? undefined : `Block ${handle}`}
              disabled={busy !== null}
              onPress={block}
              testID="block-confirm"
            />
          </>
        )}
        {busy && unconfirmed ? (
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1" testID="block-unconfirmed">
            <Text variant="subhead" tone="secondary">
              {copy.block.unconfirmed(busy === 'blocking')}
            </Text>
            {checking ? (
              <Spinner size="sm" testID="block-checking" />
            ) : (
              <LinkText label={copy.block.checkAgain} role="button" onPress={checkAgain} testID="block-check-again" />
            )}
          </View>
        ) : null}
        {/* While it is on its way this only closes the sheet: the block goes on. */}
        <Button label={busy ? copy.close : copy.cancel} variant="ghost" size="block" onPress={closeSheet} testID="block-cancel" />
      </SheetBody>
    </>
  );
}
