import type { ConversationDTO } from '@engine/api';
import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { EllipsisHorizontalIcon, PlusCircleIcon, UserGroupIcon } from 'react-native-heroicons/outline';

import { useWrite, type WriteSpec } from '~/data/writes';
import { openUser } from '~/features/post/post-navigation';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Tag } from '~/ui/Badge';
import { Button } from '~/ui/Button';
import { ContextMenu } from '~/ui/ContextMenu';
import { confirmAlert, Dialog } from '~/ui/Dialog';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { IconButton } from '~/ui/IconButton';
import { LinkText } from '~/ui/LinkText';
import { RowSkeleton } from '~/ui/Skeleton';
import { Screen } from '~/ui/Screen';
import { useBlockScreenCapture } from '~/ui/screen-capture';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';
import { tw, useColors } from '~/ui/tokens';

import { ConversationAvatar } from './ConversationAvatar';
import { hideWhileLeaving } from './dm-actions';
import { readErrorMessage, refreshDm, useConversations, useDmBackend, useDmStatus, useDmViewer, usePeople } from './dm-data';
import { conversationTitle, GROUP_NAME_MAX, groupNameError, memberCount } from './dm-model';
import {
  addMemberWrite,
  endGroupWrite,
  leaveGroupWrite,
  removeMemberWrite,
  renameGroupWrite,
  resendKeysWrite,
} from './dm-writes';
import { resendMissingKeys } from './group-keys';
import { usePickerReveal, UserPicker } from './UserPicker';

function RenameDialog({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const nameError = groupNameError(name);
  const valid = name.trim().length > 0 && name.trim() !== initial && !nameError;
  return (
    <Dialog open={open} onClose={onClose} testID="rename-dialog">
      <Text variant="headline" tone="emphasis" accessibilityRole="header" className="mb-4">
        Rename group
      </Text>
      <TextField
        label="Group name"
        value={name}
        onChangeText={setName}
        maxLength={GROUP_NAME_MAX}
        error={nameError}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={() => valid && onSave(name.trim())}
        testID="rename-input"
      />
      <View className="mt-6 flex-row justify-end gap-3">
        <Button label="Cancel" variant="outline" onPress={onClose} />
        <Button label="Save" disabled={!valid} onPress={() => onSave(name.trim())} testID="rename-save" />
      </View>
    </Dialog>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <Text variant="captionStrong" tone="secondary" accessibilityRole="header" className="px-4 pb-1 pt-6 uppercase">
      {title}
    </Text>
  );
}

function ActionRow({
  label,
  destructive,
  icon,
  disabled,
  loading,
  onPress,
  testID,
}: {
  label: string;
  destructive?: boolean;
  icon?: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      // Always labelled: Android rewrites a view's description only when it has something to say
      // (React Native's BaseViewManager), so with no label the "busy" a write adds stays on the
      // row after the write is done, and it reads busy until the screen closes (QA D-RVa-dc-01).
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className={cn('min-h-14 flex-row items-center gap-3 border-t px-4 py-3', tw.border, tw.pressed, disabled && 'opacity-50')}
    >
      {icon}
      <Text variant="body" tone={destructive ? 'destructive' : 'link'} className="flex-1">
        {label}
      </Text>
      {loading ? <Spinner size="sm" /> : null}
    </Pressable>
  );
}

/**
 * "Re-invite" from the owner's member menu (#8): the key resent by hand, the
 * fallback when the app's own resends (`group-keys`) could not reach them.
 */
const reinviteWrite: WriteSpec<{ key: string; memberId: string }> = {
  ...resendKeysWrite,
  onConfirmed: () => {
    refreshDm();
    toast.success('Invite sent');
  },
};

/**
 * Group info (UX_SPEC §4.22, PRD DM-07, DM-08): the name, members with the
 * owner's badge, and actions by role. The owner renames, adds, re-invites
 * and removes members and ends the group; a member leaves.
 */
export function GroupInfoScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  const key = conversationId ?? '';
  const c = useColors();
  useBlockScreenCapture('private', useIsFocused());
  const { signedIn, viewerId } = useDmViewer();
  const backend = useDmBackend();
  const status = useDmStatus(signedIn);
  const ready = signedIn && status.data !== undefined && !status.data.locked;
  const conversations = useConversations(ready);
  const conversation = conversations.data?.find((c) => c.key === key);
  const people = usePeople(conversation?.members ?? [], ready);

  const rename = useWrite(renameGroupWrite);
  const add = useWrite(addMemberWrite);
  const remove = useWrite(removeMemberWrite);
  const resend = useWrite(reinviteWrite);
  const leave = useWrite(leaveGroupWrite);
  const end = useWrite(endGroupWrite);
  const busy = [rename, add, remove, resend, leave, end].some((w) => w.status === 'pending');

  // A leave the tracker followed to the end while this screen is still up (adopted after a restart).
  const left = leave.status === 'confirmed';
  useEffect(() => {
    if (left) router.dismissTo('/messages');
  }, [left]);

  // The owner's app resends any key a creation could not send, each time the group opens (#8).
  const owned = conversation?.isOwner === true;
  useEffect(() => {
    if (owned) resendMissingKeys(key);
  }, [owned, key]);

  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const picker = usePickerReveal();

  const header = <Stack.Screen options={{ title: 'Group info' }} />;

  // Legacy messages have no groups: a stale link goes to the inbox (#23).
  if (backend === 'legacy') return <Redirect href="/messages" />;
  if ((status.isError && !status.data) || (conversations.isError && !conversations.data)) {
    return (
      <Screen>
        {header}
        <ErrorState
          message={readErrorMessage(status.error ?? conversations.error)}
          onRetry={() => refreshDm()}
          testID="group-info-error"
        />
      </Screen>
    );
  }
  if (!conversation && conversations.data) {
    // Gone from this device: left (and dropped), or never held here.
    return (
      <Screen>
        {header}
        <EmptyState
          icon={UserGroupIcon}
          title="This group isn't available"
          description="You may have left it, or it is not on this device."
          action={{ label: 'Back to messages', onPress: () => router.dismissTo('/messages') }}
          testID="group-info-missing"
        />
      </Screen>
    );
  }
  if (!conversation) {
    return (
      <Screen>
        {header}
        <View className="items-center py-10">
          <Spinner size="md" />
        </View>
      </Screen>
    );
  }

  const group: ConversationDTO = conversation;
  const owner = group.isOwner;
  const inactive = group.flags.ended || group.flags.removed;
  const title = conversationTitle(group);
  // The owner first, then everyone else in roster order.
  const memberIds = [
    ...(group.ownerId ? [group.ownerId] : []),
    ...group.members.filter((id) => id !== group.ownerId),
  ];

  const confirmRemove = (memberId: string, name: string) => {
    confirmAlert({
      title: `Remove ${name} from the group?`,
      message: "They won't see new messages.",
      confirmText: 'Remove',
      destructive: true,
    })
      .then((ok) => {
        if (ok) remove.run({ key, memberId }).catch(() => undefined);
      })
      .catch(() => undefined);
  };

  const confirmLeaveOrEnd = () => {
    const ask = owner
      ? {
          title: 'End this group?',
          message: 'Nobody will be able to send messages to it any more. This cannot be undone.',
          confirmText: 'End group',
        }
      : {
          title: 'Leave group?',
          message: "You'll stop getting messages from this group.",
          confirmText: 'Leave',
        };
    confirmAlert({ ...ask, destructive: true })
      .then(async (ok) => {
        if (!ok) return;
        if (owner) {
          await end.run({ key });
          return;
        }
        // Gone from the inbox at once; it comes back only if the leave fails (#8).
        const ticket = await leave.run({ key });
        if (!ticket) return;
        hideWhileLeaving(key, ticket.id);
        router.dismissTo('/messages');
      })
      .catch(() => undefined);
  };

  return (
    <Screen>
      {header}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        {...picker.scrollProps}
        testID="group-info"
      >
        <View className="items-center gap-2 px-4 pt-6">
          <ConversationAvatar conversation={group} size="xl" />
          <Text variant="title" tone="emphasis" className="text-center" testID="group-info-name">
            {title}
          </Text>
          {owner && !inactive ? (
            <LinkText label="Rename" onPress={() => setRenaming(true)} className="self-center" testID="group-rename" />
          ) : null}
          {rename.status === 'pending' ? (
            <Text variant="caption" tone="secondary">
              Renaming…
            </Text>
          ) : null}
        </View>

        {inactive ? (
          <Text variant="subhead" tone="secondary" className="px-4 pt-6 text-center" testID="group-info-state">
            {group.flags.ended ? 'This group has ended.' : 'You are no longer a member of this group.'}
          </Text>
        ) : null}

        <SectionHeader title={memberCount(group.members.length)} />
        {people.isPending && memberIds.length > 0 ? <RowSkeleton /> : null}
        {memberIds.map((id) => {
          const person = people.byId.get(id);
          const name = person?.displayName ?? `User ${id.slice(-6)}`;
          const you = id === viewerId;
          return (
            <View key={id} className="min-h-[64px] flex-row items-center gap-3 px-4 py-2" testID={`group-member-${id}`}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${name}${you ? ', you' : ''}${id === group.ownerId ? ', owner' : ''}`}
                onPress={() => openUser(id)}
                className="flex-1 flex-row items-center gap-3 active:opacity-70"
              >
                <Avatar avatar={person?.avatar} identityId={id} size="md" />
                <View className="flex-1">
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {name}
                    {you ? ' (you)' : ''}
                  </Text>
                  {person ? (
                    <Text variant="subhead" tone="secondary" numberOfLines={1}>
                      {handleOf(person)}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              {id === group.ownerId ? (
                <View>
                  <Tag label="Owner" />
                </View>
              ) : null}
              {owner && !inactive && !you ? (
                <ContextMenu
                  items={[
                    { id: 'resend', title: 'Re-invite', systemImage: 'envelope' },
                    { id: 'remove', title: 'Remove member', systemImage: 'person.badge.minus', destructive: true },
                  ]}
                  onSelect={(action) => {
                    if (action === 'resend') resend.run({ key, memberId: id }).catch(() => undefined);
                    else confirmRemove(id, name);
                  }}
                  testID={`group-member-menu-${id}`}
                >
                  <IconButton icon={EllipsisHorizontalIcon} accessibilityLabel={`Options for ${name}`} disabled={busy} />
                </ContextMenu>
              ) : null}
            </View>
          );
        })}

        {owner && !inactive ? (
          <View className="mt-2" {...picker.sectionProps} testID="group-add-section">
            <ActionRow
              label={adding ? 'Done adding' : 'Add members'}
              icon={<PlusCircleIcon size={22} color={c.link} />}
              loading={add.status === 'pending'}
              disabled={busy && !adding}
              onPress={() => setAdding((open) => !open)}
              testID="group-add"
            />
            {adding && viewerId ? (
              <View
                // The picker never moves between native parents as busy flips (mobile/CLAUDE.md, "Native view structure").
                collapsable={false}
                pointerEvents={busy ? 'none' : 'auto'}
                className={busy ? 'opacity-60' : undefined}
                style={{ minHeight: picker.minHeight }}
                testID="group-add-picker"
              >
                <UserPicker
                  viewerId={viewerId}
                  excludeIds={new Set(group.members)}
                  note="New members can read messages sent after they join."
                  onSearchFocus={picker.reveal}
                  onPick={(user) => add.run({ key, memberId: user.id, name: user.displayName }).catch(() => undefined)}
                />
              </View>
            ) : (
              <Text variant="caption" tone="secondary" className="px-4 pb-3">
                New members can read messages sent after they join.
              </Text>
            )}
          </View>
        ) : null}

        {!inactive ? (
          <View className="mb-10 mt-4">
            <ActionRow
              label={owner ? 'End group' : 'Leave group'}
              destructive
              disabled={busy}
              loading={(owner ? end : leave).status === 'pending'}
              onPress={confirmLeaveOrEnd}
              testID={owner ? 'group-end' : 'group-leave'}
            />
          </View>
        ) : null}
      </ScrollView>
      {renaming ? (
        <RenameDialog
          open
          initial={group.name ?? ''}
          onClose={() => setRenaming(false)}
          onSave={(name) => {
            setRenaming(false);
            rename.run({ key, name }).catch(() => undefined);
          }}
        />
      ) : null}
    </Screen>
  );
}
