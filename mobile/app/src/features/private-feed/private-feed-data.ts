import type { MessagingKeyDTO, PostDTO, PrivatePostDTO, WriteTicket } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useCapabilities, useViewerId } from '~/data/session';
import { sendWrite, type WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { confirmAlert } from '~/ui/Dialog';
import { toast } from '~/ui/toast';

import { copy } from './copy';

/**
 * The private-feed reads and writes the screens share (engine
 * `privateFeed.*`). Nothing here is persisted: decrypted text and the
 * owner's lists stay in memory (`queryKeys.privateFeed`).
 */

/** How long a decrypted post or an access state is reused before it is read again. */
const STALE_MS = 60_000;

/** The write keys (one write at a time per key), also what the screens watch to show a write as busy. */
export const accessKey = (ownerId: string) => `privateFeed:${ownerId}`;
export const memberKey = (memberId: string) => `privateFeed.member:${memberId}`;
export const OWNER_KEY = 'privateFeed.owner';

/**
 * A private post or reply for the viewer (`privateFeed.read`); not read for
 * a post that isn't private, nor while `enabled` is false (an optimistic
 * card, which is not on the chain yet).
 */
export function usePrivatePost(post: Pick<PostDTO, 'id' | 'encrypted'>, enabled = true) {
  const viewerId = useViewerId();
  const id = post.id;
  return useEngineQuery(
    // The viewer is in the key: an account switch never shows another account's decryption.
    [...queryKeys.privateFeed.post(id), viewerId ?? ''],
    (api) => api.privateFeed.read(id),
    { enabled: enabled && post.encrypted, staleTime: STALE_MS },
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

/** How to get the messaging key onto this phone, in a sentence; null when it is here. */
export function messagingKeyText(messagingKey: MessagingKeyDTO): string | null {
  if (messagingKey === 'ready') return null;
  return messagingKey === 'allow-in-wallet' ? copy.messagingKey.allowInWallet : copy.messagingKey.unavailable;
}

const refresh = (queryKey: readonly unknown[]) => {
  queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
};

/** After a write about `ownerId`'s feed: its access state and every private post read again. */
function refreshFeedOf(ownerId: string): void {
  refresh(queryKeys.privateFeed.access(ownerId));
  refresh(queryKeys.privateFeed.posts);
}

/**
 * A confirmed write can still be missing from the node a read right after it
 * reaches (seen on testnet: an approval's request gone, its follower not yet
 * listed), so the owner's feed is read once more after this.
 */
const READ_AGAIN_MS = 4_000;

/** After a write to the viewer's own feed: its settings, lists and private posts read again, and once more shortly. */
function refreshOwnFeed(): void {
  const readOwnFeed = () => {
    refresh(queryKeys.privateFeed.owner);
    refresh(queryKeys.privateFeed.posts);
    // Compose reads the viewer's own feed through `access` (whether there is one to post into).
    refresh(queryKeys.privateFeed.accessAll);
  };
  readOwnFeed();
  setTimeout(readOwnFeed, READ_AGAIN_MS);
}

/**
 * Whether a reply to the private post `id` is private (its thread is), for
 * compose; not read for a public target. A failed read stays an error, so
 * compose never guesses.
 */
export function useReplySource(id: string, enabled: boolean) {
  return useEngineQuery(queryKeys.privateFeed.replySource(id), (api) => api.privateFeed.replySource(id), {
    enabled,
    staleTime: STALE_MS,
  });
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
  key: ({ ownerId }) => accessKey(ownerId),
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
  key: ({ ownerId }) => accessKey(ownerId),
  submit: (api, { ownerId }) => api.privateFeed.leave(ownerId),
  matches: (ticket, { ownerId }) => ticket.op === 'privateFeed.leave' && aboutIdentity(ticket) === ownerId,
  onConfirmed: (_ticket, { ownerId }) => refreshFeedOf(ownerId),
  failureText: feedFailureText,
  failureMessage: ({ member }) => (member ? "Couldn't leave this private feed. Try again." : "Couldn't cancel your request. Try again."),
};

/** Request access to `ownerId`'s private posts, signing in first when signed out. */
export function requestAccess(ownerId: string): void {
  requireAuth(() => sendWrite(requestAccessWrite, { ownerId }, copy.access.requested));
}

/** Cancel a pending request (`member: false`) or leave a private feed, after a confirmation. */
export async function confirmLeave(ownerId: string, member: boolean): Promise<void> {
  const confirmed = await confirmAlert({
    title: member ? copy.access.leaveTitle : copy.access.cancelTitle,
    message: member ? copy.access.leaveBody : copy.access.cancelBody,
    confirmText: member ? copy.access.leave : copy.access.cancel,
    cancelText: copy.access.keep,
    destructive: true,
  });
  if (confirmed) sendWrite(leaveWrite, { ownerId, member }, member ? copy.access.left : copy.access.cancelled);
}

/** Approve a request: they can read the owner's private posts. */
export const approveWrite: WriteSpec<{ memberId: string }> = {
  key: ({ memberId }) => memberKey(memberId),
  submit: (api, { memberId }) => api.privateFeed.approve(memberId),
  matches: (ticket, { memberId }) => ticket.op === 'privateFeed.approve' && aboutIdentity(ticket) === memberId,
  onConfirmed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't approve this request. Try again.",
};

/** Remove a private follower: they can't read anything posted from now on. */
export const revokeWrite: WriteSpec<{ memberId: string }> = {
  key: ({ memberId }) => memberKey(memberId),
  submit: (api, { memberId }) => api.privateFeed.revoke(memberId),
  matches: (ticket, { memberId }) => ticket.op === 'privateFeed.revoke' && aboutIdentity(ticket) === memberId,
  onConfirmed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't remove this follower. Try again.",
};

/** Turn the viewer's private feed on. */
export const enableWrite: WriteSpec<Record<string, never>> = {
  key: () => OWNER_KEY,
  submit: (api) => api.privateFeed.enable(),
  matches: (ticket) => ticket.op === 'privateFeed.enable',
  onConfirmed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't turn on your private feed. Try again.",
};

/** Renew the viewer's private feed: new keys and room, followers moved over. */
export const renewWrite: WriteSpec<{ bringHistory: boolean }> = {
  key: () => OWNER_KEY,
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
  key: () => OWNER_KEY,
  submit: (api) => api.privateFeed.continueMove(),
  matches: (ticket) => ticket.op === 'privateFeed.move',
  onConfirmed: refreshOwnFeed,
  onFailed: refreshOwnFeed,
  failureText: feedFailureText,
  failureMessage: "Couldn't finish moving your followers. Try again.",
};
