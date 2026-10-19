import type { PostDTO, PrivatePostDTO, WriteTicket } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useCapabilities, useViewerId } from '~/data/session';
import type { WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { toast } from '~/ui/toast';

import { copy } from './copy';

/**
 * The private-feed reads and writes the screens share (engine
 * `privateFeed.*`). Nothing here is persisted: decrypted text and the
 * owner's lists stay in memory (`queryKeys.privateFeed`).
 */

/** How long a decrypted post or an access state is reused before it is read again. */
const STALE_MS = 60_000;

/**
 * A private post or reply for the viewer (`privateFeed.read`): `undefined`
 * while it loads, or for a post that isn't private. `rootOwnerHint`: who
 * started the thread, for a reply whose root is gone.
 */
export function usePrivatePost(post: Pick<PostDTO, 'id' | 'encrypted'>, rootOwnerHint?: string) {
  const viewerId = useViewerId();
  const id = post.id;
  return useEngineQuery(
    // The viewer is in the key: an account switch never shows another account's decryption.
    [...queryKeys.privateFeed.post(id), viewerId ?? ''],
    (api) => api.privateFeed.read(id, rootOwnerHint),
    { enabled: post.encrypted, staleTime: STALE_MS },
  );
}

/** Whether the viewer can reply to `post`: always for a public post; for a private one, once it opened for them (web `useCanReplyToPrivate`). */
export function canReplyTo(post: Pick<PostDTO, 'encrypted' | 'deleted'>, privateState: PrivatePostDTO | undefined): boolean {
  if (post.deleted) return false;
  return !post.encrypted || privateState?.state === 'open';
}

/** Where the viewer stands with `ownerId`'s private feed; signed out or where the network has none, not read. */
export function usePrivateAccess(ownerId: string, enabled = true) {
  const viewerId = useViewerId();
  const supported = useCapabilities()?.privateFeeds === true;
  return useEngineQuery(queryKeys.privateFeed.access(ownerId), (api) => api.privateFeed.access(ownerId), {
    enabled: enabled && supported && viewerId !== null,
    staleTime: STALE_MS,
  });
}

/** The viewer's own private feed for Settings. */
export function usePrivateFeedOverview() {
  return useEngineQuery(queryKeys.privateFeed.overview, (api) => api.privateFeed.overview());
}

const refresh = (queryKey: readonly unknown[]) => {
  queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
};

/** After a write about `ownerId`'s feed: its access state and every private post read again. */
function refreshFeedOf(ownerId: string): void {
  refresh(queryKeys.privateFeed.access(ownerId));
  refresh(queryKeys.privateFeed.posts);
}

/** After a write to the viewer's own feed: its settings, lists and private posts read again. */
export function refreshOwnFeed(): void {
  refresh(queryKeys.privateFeed.owner);
  refresh(queryKeys.privateFeed.posts);
}

const aboutIdentity = (ticket: WriteTicket) => (ticket.target as { identityId?: string } | null)?.identityId;

/**
 * A private-feed refusal the engine words itself (`PRIVATE_FEED`: full,
 * moving, withdrawn, ...), or the missing messaging key; otherwise the
 * spec's own sentence.
 */
function feedFailureText(ticket: WriteTicket): string | null {
  const error = ticket.error;
  if (error?.code === 'PRIVATE_FEED') return error.userMessage;
  if (error?.code === 'NO_MESSAGING_KEY' || error?.code === 'PRIVATE_FEED_SYNC_REQUIRED') return copy.messagingKey.needed;
  return null;
}

/** Ask an owner for access (following them first, as web does); also how a removed follower asks again. */
export const requestAccessWrite: WriteSpec<{ ownerId: string }> = {
  key: ({ ownerId }) => `privateFeed:${ownerId}`,
  submit: (api, { ownerId }) => api.privateFeed.request(ownerId),
  matches: (ticket, { ownerId }) => ticket.op === 'privateFeed.request' && aboutIdentity(ticket) === ownerId,
  onConfirmed: (_ticket, { ownerId }) => {
    refreshFeedOf(ownerId);
    // The request follows the owner first: their profile shows it.
    refresh(queryKeys.profile.detail(ownerId));
  },
  failureText: feedFailureText,
  failureMessage: "Couldn't send your request. Try again.",
};

/** Withdraw a pending request, or leave a private feed (PF8). */
export const leaveWrite: WriteSpec<{ ownerId: string; member: boolean }> = {
  key: ({ ownerId }) => `privateFeed:${ownerId}`,
  submit: (api, { ownerId }) => api.privateFeed.leave(ownerId),
  matches: (ticket, { ownerId }) => ticket.op === 'privateFeed.leave' && aboutIdentity(ticket) === ownerId,
  onConfirmed: (_ticket, { ownerId }) => refreshFeedOf(ownerId),
  failureText: feedFailureText,
  failureMessage: ({ member }) => (member ? "Couldn't leave this private feed. Try again." : "Couldn't cancel your request. Try again."),
};

/** Approve a request: they can read the owner's private posts. */
export const approveWrite: WriteSpec<{ memberId: string }> = {
  key: ({ memberId }) => `privateFeed.member:${memberId}`,
  submit: (api, { memberId }) => api.privateFeed.approve(memberId),
  matches: (ticket, { memberId }) => ticket.op === 'privateFeed.approve' && aboutIdentity(ticket) === memberId,
  onConfirmed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't approve this request. Try again.",
};

/** Remove a private follower: they can't read anything posted from now on. */
export const revokeWrite: WriteSpec<{ memberId: string }> = {
  key: ({ memberId }) => `privateFeed.member:${memberId}`,
  submit: (api, { memberId }) => api.privateFeed.revoke(memberId),
  matches: (ticket, { memberId }) => ticket.op === 'privateFeed.revoke' && aboutIdentity(ticket) === memberId,
  onConfirmed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't remove this follower. Try again.",
};

/** Turn the viewer's private feed on. */
export const enableWrite: WriteSpec<Record<string, never>> = {
  key: () => 'privateFeed.owner',
  submit: (api) => api.privateFeed.enable(),
  matches: (ticket) => ticket.op === 'privateFeed.enable',
  onConfirmed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't turn on your private feed. Try again.",
};

/** Renew the viewer's private feed: new keys and room, followers moved over. */
export const renewWrite: WriteSpec<{ bringHistory: boolean }> = {
  key: () => 'privateFeed.owner',
  submit: (api, vars) => api.privateFeed.renew(vars),
  matches: (ticket) => ticket.op === 'privateFeed.renew',
  onConfirmed: () => {
    refreshOwnFeed();
    toast.success(copy.renew.renewed);
  },
  // A paused move keeps its place: Settings shows it with Continue.
  onFailed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't renew your private feed. Try again.",
};

/** Continue moving followers after a renewal. */
export const continueMoveWrite: WriteSpec<Record<string, never>> = {
  key: () => 'privateFeed.owner',
  submit: (api) => api.privateFeed.continueMove(),
  matches: (ticket) => ticket.op === 'privateFeed.move',
  onConfirmed: refreshOwnFeed,
  onFailed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't finish moving your followers. Try again.",
};
