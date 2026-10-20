import type { PollDTO } from '@engine/api';

import { queryKeys } from '~/data/keys';
import type { WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';

export interface PollVoteVars {
  pollId: string;
  /** The option indexes the ballot selects; none withdraws it (editable polls only). */
  choices: number[];
}

export const pollVoteKey = (pollId: string) => `poll:${pollId}`;

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
 * at once, which a lagging node could answer with the old ballot; the next read
 * (a refresh) brings the chain's tally.
 */
export const pollVoteWrite: WriteSpec<PollVoteVars> = {
  key: ({ pollId }) => pollVoteKey(pollId),
  intent: ({ choices }) => [...choices].sort((a, b) => a - b).join(','),
  submit: (api, { pollId, choices }) => api.posts.vote(pollId, choices),
  // Its change is the query cache's alone, which the chain read repairs.
  reconcile: null,
  optimistic: applyBallot,
  reapply: (vars) => {
    applyBallot(vars);
  },
  failureMessage: ({ choices }) => (choices.length > 0 ? "Couldn't save your vote. Try again." : "Couldn't withdraw your vote. Try again."),
  failureText: (ticket) => (ticket.error?.code === 'BAD_REQUEST' ? ticket.error.userMessage : null),
};
