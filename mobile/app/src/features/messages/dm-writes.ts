import type { WriteTicket } from '@engine/api';

import { queryKeys } from '~/data/keys';
import type { EngineRemote } from '~/data/queries';
import { errorCode, type WriteSpec } from '~/data/writes';
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

/** The failure sentence of every group change but leaving and creating (UX_SPEC §5.4). */
const GROUP_UPDATE_FAILED = "Couldn't update the group. Try again.";

function groupSpec<V extends { key: string }>(
  submit: WriteSpec<V>['submit'],
  done: string,
  failureMessage: string,
  writeKey: (vars: V) => string = ({ key }) => `dm.group:${key}`,
): WriteSpec<V> {
  return {
    submit,
    key: writeKey,
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
  GROUP_UPDATE_FAILED,
);

export const addMemberWrite = groupSpec<{ key: string; memberId: string; name: string }>(
  (api, { key, memberId }) => api.dm.addMember(key, memberId),
  'Member added',
  GROUP_UPDATE_FAILED,
  ({ key, memberId }) => `dm.group:${key}:${memberId}`,
);

export const removeMemberWrite = groupSpec<{ key: string; memberId: string }>(
  (api, { key, memberId }) => api.dm.removeMember(key, memberId),
  'Member removed',
  GROUP_UPDATE_FAILED,
  ({ key, memberId }) => `dm.group:${key}:${memberId}`,
);

export const resendKeysWrite = groupSpec<{ key: string; memberId: string }>(
  (api, { key, memberId }) => api.dm.resendKeys(key, memberId),
  'Keys sent',
  GROUP_UPDATE_FAILED,
  ({ key, memberId }) => `dm.keys:${key}:${memberId}`,
);

export const leaveGroupWrite = groupSpec<{ key: string }>(
  (api, { key }) => api.dm.leaveGroup(key),
  'You left the group',
  "Couldn't leave the group. Try again.",
);

export const endGroupWrite = groupSpec<{ key: string }>(
  (api, { key }) => api.dm.endGroup(key),
  'Group ended',
  GROUP_UPDATE_FAILED,
);

export interface CreateGroupVars {
  name: string;
  memberIds: string[];
}

/** How long a creation waits for v5's saved state to load (the reads' `ENGINE_BUSY` budget, as `startDirectWhenReady`). */
const LOAD_WAIT_MS = 60_000;

/**
 * `dm.createGroup`, waiting out the first load: until v5's saved state has
 * loaded the engine cannot list the groups there are (to tell the new one
 * apart) and answers `ENGINE_BUSY`. A creation already running is
 * `ENGINE_BUSY` too, with the state loaded: that one is not waited out.
 */
async function createGroupWhenLoaded(api: EngineRemote, { name, memberIds }: CreateGroupVars): Promise<WriteTicket> {
  const deadline = Date.now() + LOAD_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api.dm.createGroup(name, memberIds);
    } catch (error) {
      if (errorCode(error) !== 'ENGINE_BUSY' || Date.now() >= deadline || (await api.dm.status()).ready) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 4000)));
  }
}

/** DM-06: one creation at a time (the engine refuses a second with `ENGINE_BUSY`). */
export const createGroupWrite: WriteSpec<CreateGroupVars> = {
  submit: createGroupWhenLoaded,
  key: () => 'dm.createGroup',
  failureMessage: "Couldn't create the group. Try again.",
  onConfirmed: refreshInbox,
};
