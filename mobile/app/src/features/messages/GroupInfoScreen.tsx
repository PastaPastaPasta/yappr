import type { ConversationDTO } from '@engine/api';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { EllipsisHorizontalIcon, PlusCircleIcon, UserGroupIcon } from 'react-native-heroicons/outline';

import { useWrite } from '~/data/writes';
import { openUser } from '~/features/post/post-navigation';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Tag } from '~/ui/Badge';
import { Button } from '~/ui/Button';
import { ContextMenu } from '~/ui/ContextMenu';
import { confirmAlert, Dialog } from '~/ui/Dialog';
import { EmptyState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { IconButton } from '~/ui/IconButton';
import { LinkText } from '~/ui/LinkText';
import { RowSkeleton } from '~/ui/Skeleton';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { tw, useColors } from '~/ui/tokens';

import { ConversationAvatar } from './ConversationAvatar';
import { useConversation, useDmBackend, useDmStatus, useDmViewer, usePeople } from './dm-data';
import { conversationTitle, memberCount } from './dm-model';
import {
  addMemberWrite,
  endGroupWrite,
  leaveGroupWrite,
  removeMemberWrite,
  renameGroupWrite,
  resendKeysWrite,
} from './dm-writes';
import { UserPicker } from './UserPicker';

const NAME_MAX = 100;

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
  const valid = name.trim().length > 0 && name.trim() !== initial;
  return (
    <Dialog open={open} onClose={onClose} testID="rename-dialog">
      <Text variant="headline" tone="emphasis" accessibilityRole="header" className="mb-4">
        Rename group
      </Text>
      <TextField
        label="Group name"
        value={name}
        onChangeText={setName}
        maxLength={NAME_MAX}
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
 * Group info (UX_SPEC §4.22, PRD DM-07, DM-08): the name, members with the
 * owner's badge, and actions by role. The owner renames, adds and removes
 * members, resends keys and ends the group; a member leaves.
 */
export function GroupInfoScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  const key = conversationId ?? '';
  const c = useColors();
  const { signedIn, viewerId } = useDmViewer();
  const backend = useDmBackend();
  const status = useDmStatus(signedIn);
  const ready = signedIn && status.data !== undefined && !status.data.locked;
  const conversation = useConversation(key, ready);
  const people = usePeople(conversation?.members ?? [], ready);

  const rename = useWrite(renameGroupWrite);
  const add = useWrite(addMemberWrite);
  const remove = useWrite(removeMemberWrite);
  const resend = useWrite(resendKeysWrite);
  const leave = useWrite(leaveGroupWrite);
  const end = useWrite(endGroupWrite);
  const busy = [rename, add, remove, resend, leave, end].some((w) => w.status === 'pending');

  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);

  const header = <Stack.Screen options={{ title: 'Group info' }} />;

  if (backend === 'legacy') {
    return (
      <Screen>
        {header}
        <EmptyState icon={UserGroupIcon} title="Groups aren't available on this network" />
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
      title: 'Remove member?',
      message: `${name} will not be able to read new messages. This writes a new group key for everyone else.`,
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
          title: 'Leave this group?',
          message: 'The owner removes you the next time they open the app. Until then you can still read new messages.',
          confirmText: 'Leave',
        };
    confirmAlert({ ...ask, destructive: true })
      .then((ok) => {
        if (!ok) return;
        (owner ? end : leave).run({ key }).catch(() => undefined);
      })
      .catch(() => undefined);
  };

  return (
    <Screen>
      {header}
      <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" testID="group-info">
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
                    { id: 'resend', title: 'Resend keys', systemImage: 'key' },
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
          <View className="mt-2">
            <ActionRow
              label={adding ? 'Done adding' : 'Add members'}
              icon={<PlusCircleIcon size={22} color={c.link} />}
              loading={add.status === 'pending'}
              disabled={busy && !adding}
              onPress={() => setAdding((open) => !open)}
              testID="group-add"
            />
            {adding && viewerId ? (
              <View pointerEvents={busy ? 'none' : 'auto'} className={busy ? 'opacity-60' : undefined}>
                <UserPicker
                  viewerId={viewerId}
                  excludeIds={new Set(group.members)}
                  note="New members can read messages sent after they join."
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
