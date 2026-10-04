import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { XMarkIcon } from 'react-native-heroicons/outline';

import { useWrite } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { selectionTick } from '~/ui/haptics';
import { KeyboardAvoider } from '~/ui/KeyboardAvoider';
import { LinkText } from '~/ui/LinkText';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';
import { hitSlopFor, tw, useColors } from '~/ui/tokens';

import { useDmViewer } from './dm-data';
import { GROUP_NAME_MAX, groupNameError } from './dm-model';
import { createGroupWrite, resendKeysTo } from './dm-writes';
import { DmSignedOut } from './DmStates';
import { CloseButton, leaveModalFor } from './NewMessageScreen';
import { UserPicker, type PickerUser } from './UserPicker';

/** At most 100 members including the creator (PRD DM-06). */
const MAX_MEMBERS = 100;

function MemberChip({ user, onRemove, disabled }: { user: PickerUser; onRemove: () => void; disabled: boolean }) {
  const c = useColors();
  return (
    <View className={cn('flex-row items-center gap-1.5 rounded-full py-1 pl-1 pr-2', tw.bgMuted)}>
      <Avatar avatar={user.avatar} identityId={user.id} size="xs" />
      <Text variant="subhead" numberOfLines={1} style={{ maxWidth: 140 }}>
        {user.displayName}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${user.displayName}`}
        hitSlop={hitSlopFor(16)}
        disabled={disabled}
        onPress={onRemove}
        testID={`chip-remove-${user.id}`}
      >
        <XMarkIcon size={16} color={c.textSecondary} />
      </Pressable>
    </View>
  );
}

/**
 * New group (UX_SPEC §4.21, PRD DM-06): a name (1–100 characters), members
 * as removable chips, and "Create group", which writes the roster and a key
 * per member (one `dm.group` ticket) and then opens the group.
 */
export function NewGroupScreen() {
  const { signedIn, viewerId } = useDmViewer();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<PickerUser[]>([]);
  const create = useWrite(createGroupWrite);
  // Not confirmed (a timeout or a 504) may still have landed: a second creation could make a
  // second group, so the form stays locked until a check settles it. A check that proved it
  // did not land comes back retryable, and the tracker says "Try again".
  const unconfirmed = create.status === 'unconfirmed' && create.ticket?.retryable !== true;
  const [checking, setChecking] = useState(false);
  // The status stays idle until the engine answers with a ticket: a second tap meanwhile would
  // queue a second creation behind the first (a second group), so the form locks at the tap.
  const submitting = useRef(false);
  const [awaitingTicket, setAwaitingTicket] = useState(false);
  // Confirmed is final: the form stays locked while the new group is looked up and opened.
  const busy = awaitingTicket || create.status === 'pending' || create.status === 'confirmed' || unconfirmed;
  const nameError = groupNameError(name);
  const canCreate = !busy && name.trim().length > 0 && !nameError && members.length > 0;
  const selected = new Set(members.map((m) => m.id));

  const toggle = (user: PickerUser) => {
    selectionTick();
    if (selected.has(user.id)) {
      setMembers((list) => list.filter((m) => m.id !== user.id));
    } else if (members.length + 1 >= MAX_MEMBERS) {
      toast.error('A group can have at most 100 members.');
    } else {
      setMembers((list) => [...list, user]);
    }
  };

  const submit = () => {
    if (!canCreate || submitting.current) return;
    submitting.current = true;
    setAwaitingTicket(true);
    create
      .send({ name: name.trim(), memberIds: members.map((m) => m.id) })
      .then((result) => {
        // The engine restarted under the call: the group may exist, and the inbox will show it.
        if (result.status === 'unknown') {
          toast('The group may have been created. Check your messages before trying again.');
          router.dismissTo('/messages');
        }
      })
      .catch(() => undefined)
      .finally(() => {
        submitting.current = false;
        setAwaitingTicket(false);
      });
  };

  const check = () => {
    setChecking(true);
    create
      .check()
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  // Confirmed: open the new group, and offer to resend the key to anyone the creation missed.
  const ticketId = create.ticket?.id;
  useEffect(() => {
    if (create.status !== 'confirmed' || !ticketId) return;
    engine.api.dm
      .createdGroup(ticketId)
      .then((created) => {
        if (!created) {
          // Created, but the engine restarted since and no longer knows which group: the inbox has it.
          toast.success('Group created');
          router.dismissTo('/messages');
          return;
        }
        leaveModalFor(created.key);
        if (created.failed.length > 0) {
          toast.error(`${created.failed.length} member(s) did not get the group key yet.`, {
            action: { label: 'Resend keys', onPress: () => resendKeysTo(created.key, created.failed) },
          });
        }
      })
      .catch((error: unknown) => {
        // The group exists; only finding it failed. The inbox lists it.
        appendLog('warn', 'host', `dm.createdGroup failed: ${errorMessage(error)}`);
        toast.success('Group created');
        router.dismissTo('/messages');
      });
  }, [create.status, ticketId]);

  const createButton = (
    <Button
      label="Create group"
      size={Platform.OS === 'ios' ? 'sm' : 'block'}
      disabled={!canCreate}
      loading={awaitingTicket || create.status === 'pending' || create.status === 'confirmed'}
      onPress={submit}
      testID="new-group-create"
    />
  );

  const header = (
    <Stack.Screen
      options={{
        title: 'New group',
        headerLeft: () => <CloseButton />,
        headerRight: Platform.OS === 'ios' && signedIn ? () => createButton : undefined,
        gestureEnabled: !busy,
      }}
    />
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
      {/* Android's "Create group" sits under the list, and the keyboard is up while members are
          searched for: the footer rides above it (QA keyboard-overlaps). */}
      <KeyboardAvoider>
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentInsetAdjustmentBehavior="automatic">
          <View className="gap-3 px-4 pb-2 pt-3">
            <Text variant="subhead" tone="secondary">
              Name the group and pick its members.
            </Text>
            <TextField
              label="Group name"
              value={name}
              onChangeText={setName}
              maxLength={GROUP_NAME_MAX}
              error={nameError}
              editable={!busy}
              placeholder="Builders"
              returnKeyType="done"
              testID="new-group-name"
            />
            {members.length > 0 ? (
              <View className="flex-row flex-wrap gap-2" testID="new-group-chips">
                {members.map((user) => (
                  <MemberChip key={user.id} user={user} disabled={busy} onRemove={() => toggle(user)} />
                ))}
              </View>
            ) : null}
            {unconfirmed ? (
              <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1" accessibilityLiveRegion="polite">
                <Text variant="caption" tone="secondary" testID="new-group-unconfirmed">
                  Not confirmed yet. It may still have gone through.
                </Text>
                {checking ? (
                  <Spinner size="sm" />
                ) : (
                  <LinkText label="Check" onPress={check} testID="new-group-check" />
                )}
              </View>
            ) : busy ? (
              <Text variant="caption" tone="secondary" accessibilityLiveRegion="polite" testID="new-group-progress">
                Creating the group and sending each member its key. This can take a little while.
              </Text>
            ) : null}
          </View>
          {/* Its own native parent while busy and after, so creating the group (which then leaves this
              screen) never moves the picker (mobile/CLAUDE.md, "Native view structure"). */}
          <View collapsable={false} pointerEvents={busy ? 'none' : 'auto'} className={busy ? 'opacity-50' : undefined}>
            <UserPicker viewerId={viewerId} multi selectedIds={selected} onPick={toggle} />
          </View>
        </ScrollView>
        {Platform.OS === 'android' ? (
          <View className={cn('border-t px-4 pt-3', tw.border)} style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
            {createButton}
          </View>
        ) : null}
      </KeyboardAvoider>
    </Screen>
  );
}
