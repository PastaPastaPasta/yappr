import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { NoSymbolIcon, UserIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { sendWrite } from '~/data/writes';
import { errorMessage } from '~/engine/logs';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { mediumImpact } from '~/ui/haptics';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { monoFont, useColors } from '~/ui/tokens';

import { blockWrite, useAuthorBlocked } from './block-state';
import { findCachedUser } from './cached';
import { copy } from './copy';
import { SheetBody, SheetHeading, SheetLoading, SheetMessage, closeSheet, signInAction } from './SafetySheet';

/** `block.message` (`safety.block` refuses more). */
export const BLOCK_NOTE_MAX = 280;

/**
 * Block or unblock an account (PRD SAFE-01, SAFE-02; UX_SPEC §4.39), from a
 * post's, profile's or conversation's menu. A block is a public, paid
 * document, so it asks first, with an optional public note. On "Block" the
 * account's posts leave every list at once and the sheet closes; the toast
 * follows the write. An account already blocked offers "Unblock".
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
  const [note, setNote] = useState('');
  const c = useColors();

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
    sendWrite(
      blockWrite,
      { viewerId: ownViewerId, userId, block: true, message: message || undefined, user: row },
      copy.toast.blocked,
    );
    closeSheet();
  };
  const unblock = () => {
    sendWrite(blockWrite, { viewerId: ownViewerId, userId, block: false }, copy.toast.unblocked);
    closeSheet();
  };

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
        {profile.isPending ? (
          <View className="items-center py-6" testID="block-loading">
            <Spinner />
          </View>
        ) : blocked ? (
          <>
            <SheetHeading icon={NoSymbolIcon} iconColor={c.destructive} title={copy.block.blockedTitle(handle)} body={copy.block.blockedBody} />
            <Button
              label={copy.block.unblock}
              size="block"
              icon={UserIcon}
              accessibilityLabel={`Unblock ${handle}`}
              onPress={unblock}
              testID="unblock-confirm"
            />
          </>
        ) : (
          <>
            <SheetHeading icon={NoSymbolIcon} iconColor={c.destructive} title={copy.block.title(handle)} body={copy.block.body} />
            <View className="gap-1">
              <TextField
                label={copy.block.note}
                value={note}
                onChangeText={setNote}
                maxLength={BLOCK_NOTE_MAX}
                multiline
                testID="block-note"
              />
              <Text variant="caption" tone="secondary">
                {copy.block.noteHint}
              </Text>
            </View>
            <Button
              label={copy.block.confirm}
              variant="destructive"
              size="block"
              icon={NoSymbolIcon}
              accessibilityLabel={`Block ${handle}`}
              onPress={block}
              testID="block-confirm"
            />
          </>
        )}
        <Button label={copy.cancel} variant="ghost" size="block" onPress={closeSheet} testID="block-cancel" />
      </SheetBody>
    </>
  );
}
