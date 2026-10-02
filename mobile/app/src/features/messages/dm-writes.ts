import { queryKeys } from '~/data/keys';
import { sendWrite, type WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { toast } from '~/ui/toast';

/**
 * Group changes (PRD DM-06, DM-07): `dm.group` write tickets. Each confirms
 * with its toast and re-reads the inbox; failures are the tracker's to
 * report (src/data/README.md "Writes").
 */

const refreshInbox = () => {
  queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations }).catch(() => undefined);
  queryClient.invalidateQueries({ queryKey: queryKeys.dm.status }).catch(() => undefined);
};

function groupSpec<V extends { key: string }>(
  submit: WriteSpec<V>['submit'],
  done: string,
  noun: string,
  failureMessage: string,
  writeKey: (vars: V) => string = ({ key }) => `dm.group:${key}`,
): WriteSpec<V> {
  return {
    submit,
    key: writeKey,
    noun,
    failureMessage,
    onConfirmed: () => {
      refreshInbox();
      toast.success(done);
    },
  };
}

export const renameGroupWrite = groupSpec<{ key: string; name: string }>(
  (api, { key, name }) => api.dm.renameGroup(key, name),
  'Group renamed',
  'group name',
  "Couldn't rename the group. Please try again.",
);

export const addMemberWrite = groupSpec<{ key: string; memberId: string; name: string }>(
  (api, { key, memberId }) => api.dm.addMember(key, memberId),
  'Member added',
  'new member',
  "Couldn't add the member. Please try again.",
  ({ key, memberId }) => `dm.group:${key}:${memberId}`,
);

export const removeMemberWrite = groupSpec<{ key: string; memberId: string }>(
  (api, { key, memberId }) => api.dm.removeMember(key, memberId),
  'Member removed',
  'change',
  "Couldn't remove the member. Please try again.",
  ({ key, memberId }) => `dm.group:${key}:${memberId}`,
);

export const resendKeysWrite = groupSpec<{ key: string; memberId: string }>(
  (api, { key, memberId }) => api.dm.resendKeys(key, memberId),
  'Keys sent',
  'keys',
  "Couldn't send the keys. Please try again.",
  ({ key, memberId }) => `dm.keys:${key}:${memberId}`,
);

export const leaveGroupWrite = groupSpec<{ key: string }>(
  (api, { key }) => api.dm.leaveGroup(key),
  'You left the group',
  'change',
  "Couldn't leave the group. Please try again.",
);

export const endGroupWrite = groupSpec<{ key: string }>(
  (api, { key }) => api.dm.endGroup(key),
  'Group ended',
  'change',
  "Couldn't end the group. Please try again.",
);

export interface CreateGroupVars {
  name: string;
  memberIds: string[];
}

/** DM-06: one creation at a time (the engine refuses a second with `ENGINE_BUSY`). */
export const createGroupWrite: WriteSpec<CreateGroupVars> = {
  submit: (api, { name, memberIds }) => api.dm.createGroup(name, memberIds),
  key: () => 'dm.createGroup',
  noun: 'group',
  failureMessage: 'Could not create the group',
  onConfirmed: refreshInbox,
};

/** "Resend keys" to each member a creation could not reach. */
export function resendKeysTo(key: string, memberIds: readonly string[]): void {
  for (const memberId of memberIds) sendWrite(resendKeysWrite, { key, memberId });
}
