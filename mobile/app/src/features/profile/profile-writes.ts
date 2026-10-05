import type { AvatarDTO, ProfilePatchDTO, WriteTicket } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { applyProfileChange, setProfileChange, type ProfileChange } from '~/data/optimistic';
import type { WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';

import { partialSaveFailure } from './edit-profile-form';

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
  /** The avatar `patch.avatar` sets, as the form previews it (the identity's default for `null`). */
  avatar?: AvatarDTO;
}

/**
 * The save as the viewer's cached profile shows it: trimmed, as the engine
 * stores it. A blank name keeps the stored one (dev).
 */
export function profileChangeOf({ patch, avatar }: ProfileUpdateVars): ProfileChange {
  const change: ProfileChange = { hasProfile: true };
  const name = patch.displayName?.trim();
  if (name) change.displayName = name;
  for (const field of ['bio', 'location', 'website', 'pronouns'] as const) {
    const value = patch[field];
    if (value !== undefined) change[field] = value.trim() || undefined;
  }
  if (patch.bannerUri !== undefined) change.bannerUrl = patch.bannerUri?.trim() || undefined;
  if (patch.nsfw !== undefined) change.nsfw = patch.nsfw;
  if (patch.avatar !== undefined && avatar) change.avatar = avatar;
  return change;
}

/**
 * Another change from the account may still land (lib holds the save back,
 * `PENDING_WRITE`): nothing was sent, and Save works again once it has, or
 * at the latest once lib stops waiting for it (15 minutes after it was sent).
 */
export const STILL_SAVING_MESSAGE = 'Your last change is still saving. Try again in a few minutes.';

/**
 * A dev save whose second document (the Yappr profile) failed after the
 * first (the DashPay profile) was written: the name and bio did save, so
 * they stay on the profile the undo put back (an avatar may be in either:
 * the next read of the profile shows it).
 */
function keepFirstDocument(ticket: WriteTicket, vars: ProfileUpdateVars): void {
  const { progress } = ticket;
  if (!progress || progress.total < 2 || progress.done < 1) return;
  const change = profileChangeOf(vars);
  const saved: ProfileChange = {};
  if ('displayName' in change) saved.displayName = change.displayName;
  if ('bio' in change) saved.bio = change.bio;
  if (Object.keys(saved).length > 0) applyProfileChange(vars.viewerId, saved);
}

const stillSaving = (ticket: WriteTicket) => ticket.error?.code === 'PENDING_WRITE';

/**
 * Edit profile's save. The form waits on the write (it shows "Saving…" and
 * closes once the save is confirmed or may have landed), while the viewer's
 * cached profile shows the change at once: a save whose confirmation timed
 * out counts as done (PRD G-3), and the reconciler checks it. A failure, or
 * a check that proves it absent, undoes it with the failure toast. Once
 * confirmed, everything showing the viewer's name or avatar is read again.
 */
export const profileUpdateWrite: WriteSpec<ProfileUpdateVars> = {
  key: ({ viewerId }) => `profile:${viewerId}`,
  submit: (api, { patch }) => api.profiles.update(patch),
  optimistic: (vars) => setProfileChange(vars.viewerId, profileChangeOf(vars)),
  reapply: (vars, queries) => {
    applyProfileChange(vars.viewerId, profileChangeOf(vars), queries);
  },
  // An earlier change still on its way says so, with no Retry: Save works again once it lands.
  // A dev save that wrote the DashPay profile and then failed names what did not save (#20).
  failureText: (ticket, { patch }) => (stillSaving(ticket) ? STILL_SAVING_MESSAGE : partialSaveFailure(ticket, patch)),
  failureNeutral: stillSaving,
  onFailed: keepFirstDocument,
  // A second Save of the same change before the first answers is dropped, not sent again
  // (each send of an unchanged profile is another paid replace on v2).
  intent: ({ patch }) => JSON.stringify(patch),
  onConfirmed: () => {
    refetch(queryKeys.profile.all);
    refetch(queryKeys.feed.all);
    refetch(queryKeys.post.all);
  },
  matches: (ticket, { viewerId }) => ticket.op === 'profile.update' && targetIdentity(ticket) === viewerId,
  failureMessage: "Couldn't save your profile. Try again.",
};
