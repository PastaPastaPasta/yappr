import type { ProfileDTO, ProfilePatchDTO, WriteTicket } from '@engine/api';

import { queryKeys } from '~/data/keys';
import type { WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';

/** The profile writes (PRD PROF-06 – PROF-08, PROF-11). Follow is `followWrite` (features/post). */

const targetIdentity = (ticket: WriteTicket) => (ticket.target as { identityId?: string } | null)?.identityId;

const refetch = (key: readonly unknown[]) => {
  queryClient.invalidateQueries({ queryKey: key }).catch(() => undefined);
};

/**
 * Patches every cached `ProfileDTO` of `identityId` (a profile may be cached
 * under its id and under a DPNS name). Returns the undo, which refetches.
 */
export function patchCachedProfile(identityId: string, patch: (profile: ProfileDTO) => ProfileDTO): () => void {
  const previous = new Map<string, ProfileDTO>();
  for (const [key, data] of queryClient.getQueriesData<ProfileDTO | null>({ queryKey: queryKeys.profile.all })) {
    // Only profile details: `[...root, 'profile', idOrName]`, holding this identity.
    if (key.length !== queryKeys.profile.all.length + 1 || !data || data.id !== identityId) continue;
    previous.set(JSON.stringify(key), data);
    queryClient.setQueryData(key, patch(data), { updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt });
  }
  return () => {
    for (const [key, data] of previous) queryClient.setQueryData(JSON.parse(key) as unknown[], data);
    refetch(queryKeys.profile.detail(identityId));
  };
}

export interface ProfileUpdateVars {
  viewerId: string;
  patch: ProfilePatchDTO;
}

/**
 * Edit profile's save. Not optimistic: the form waits on the write (it
 * shows "Saving…" and closes once confirmed), then everything showing the
 * viewer's name or avatar is read again.
 */
export const profileUpdateWrite: WriteSpec<ProfileUpdateVars> = {
  key: ({ viewerId }) => `profile:${viewerId}`,
  submit: (api, { patch }) => api.profiles.update(patch),
  onConfirmed: () => {
    refetch(queryKeys.profile.all);
    refetch(queryKeys.feed.all);
    refetch(queryKeys.post.all);
  },
  matches: (ticket, { viewerId }) => ticket.op === 'profile.update' && targetIdentity(ticket) === viewerId,
  noun: 'profile update',
  failureMessage: 'Failed to update profile',
};

/**
 * Unblock from a profile (PRD PROF-11, PROF-13): the blocked notice goes at
 * once. A block that comes from a followed block list fails with
 * `STILL_BLOCKED`, whose message the tracker shows, and the notice returns.
 */
export const unblockWrite: WriteSpec<{ userId: string }> = {
  key: ({ userId }) => `block:${userId}`,
  submit: (api, { userId }) => api.safety.unblock(userId),
  optimistic: ({ userId }) =>
    patchCachedProfile(userId, (profile) =>
      profile.viewer ? { ...profile, viewer: { ...profile.viewer, blocks: false } } : profile,
    ),
  onConfirmed: () => {
    refetch(queryKeys.blocked);
    refetch(queryKeys.feed.all);
  },
  matches: (ticket, { userId }) => ticket.op === 'unblock' && targetIdentity(ticket) === userId,
  noun: 'unblock',
  failureMessage: 'Failed to unblock user',
};
