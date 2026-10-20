import type { PollDTO } from '@engine/api';

import { queryKeys } from '~/data/keys';
import type { WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { ballotKey } from '~/ui/post/PollCard';

export interface PollVoteVars {
  pollId: string;
  /** The option indexes the ballot selects; none withdraws it (editable polls only). */
  choices: number[];
}

export const pollVoteKey = (pollId: string) => `poll:${pollId}`;

/** A pull to refresh reads the polls on screen again too: they are their own queries, not part of a post. */
export function refetchPolls(): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.post.pollAll }).catch(() => undefined);
}

/** How long after a confirmed ballot the poll is read again: long enough for every node to have it. */
const REREAD_AFTER_MS = 15_000;

/**
 * The viewer's ballot on the cached poll, with the tally moved to match:
 * their old choices lose a vote, the new ones gain one (a total counts
 * selections). Returns the undo.
 */
function applyBallot({ pollId, choices }: PollVoteVars): () => void {
  const key = queryKeys.post.poll(pollId);
  const previous = queryClient.getQueryData<PollDTO | null>(key);
  if (!previous) return () => undefined;
  const before = previous.myVotes ?? [];
  queryClient.setQueryData<PollDTO>(key, {
    ...previous,
    myVotes: [...choices],
    options: previous.options.map((option, i) => ({
      ...option,
      votes: Math.max(0, option.votes - (before.includes(i) ? 1 : 0) + (choices.includes(i) ? 1 : 0)),
    })),
    totalVotes: previous.totalVotes === null ? null : Math.max(0, previous.totalVotes - before.length + choices.length),
  });
  return () => queryClient.setQueryData(key, previous);
}

/**
 * A poll ballot (web's poll-card.tsx Vote / Change vote / Withdraw). The card
 * shows it at once and waits while it lands; a refusal puts the old ballot
 * back with the engine's sentence (closed, already voted), anything else the
 * generic one. A confirmed ballot keeps the change rather than reading the poll
 * at once, which a lagging node could answer with the old ballot; it is read
 * again a little later (and on a pull to refresh) for the chain's tally.
 */
export const pollVoteWrite: WriteSpec<PollVoteVars> = {
  key: ({ pollId }) => pollVoteKey(pollId),
  intent: ({ choices }) => ballotKey(choices),
  submit: (api, { pollId, choices }) => api.posts.vote(pollId, choices),
  // Its change is the query cache's alone, which the chain read repairs.
  reconcile: null,
  optimistic: applyBallot,
  reapply: (vars) => {
    applyBallot(vars);
  },
  failureMessage: ({ choices }) => (choices.length > 0 ? "Couldn't save your vote. Try again." : "Couldn't withdraw your vote. Try again."),
  failureText: (ticket) => (ticket.error?.code === 'BAD_REQUEST' ? ticket.error.userMessage : null),
  // A ticket the engine kept when a restart cut the call short.
  matches: (ticket, { pollId }) =>
    ticket.op === 'poll.vote' && (ticket.target as { pollId?: string } | null)?.pollId === pollId,
  onConfirmed: (_ticket, { pollId }) => {
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.post.poll(pollId) }).catch(() => undefined);
    }, REREAD_AFTER_MS);
  },
};
