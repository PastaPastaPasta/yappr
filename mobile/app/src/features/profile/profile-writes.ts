import type { ProfilePatchDTO, WriteTicket } from '@engine/api';

import { queryKeys } from '~/data/keys';
import type { WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';

/**
 * The profile writes (PRD PROF-06 – PROF-08). Follow is `followWrite`
 * (features/post); block and unblock are `blockWrite` (features/safety).
 */

const targetIdentity = (ticket: WriteTicket) => (ticket.target as { identityId?: string } | null)?.identityId;

const refetch = (key: readonly unknown[]) => {
  queryClient.invalidateQueries({ queryKey: key }).catch(() => undefined);
};

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
