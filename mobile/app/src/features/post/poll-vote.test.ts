import type { PollDTO, WriteTicket } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { queryClient } from '~/state/query-client';

import { pollVoteWrite } from './poll-vote';

const restored = (op: string, target: unknown) => ({ op, target }) as unknown as WriteTicket;

describe('pollVoteWrite', () => {
  it("recognises its own ballot ticket after a restart cut the call short, and no other poll's", () => {
    const vars = { pollId: 'p1', choices: [1] };
    expect(pollVoteWrite.matches?.(restored('poll.vote', { pollId: 'p1' }), vars)).toBe(true);
    expect(pollVoteWrite.matches?.(restored('poll.vote', { pollId: 'p2' }), vars)).toBe(false);
    expect(pollVoteWrite.matches?.(restored('like', { pollId: 'p1' }), vars)).toBe(false);
  });

  it('moves the tally to the new ballot at once, and undoes it', () => {
    const key = queryKeys.post.poll('p1');
    const poll = {
      id: 'p1', ownerId: 'o', question: 'Q', multiChoice: false, endsAt: null, createdAt: new Date(0), tallyIncludesLate: false,
      options: [{ text: 'a', votes: 3 }, { text: 'b', votes: 1 }], totalVotes: 4, myVotes: [0],
    } satisfies PollDTO;
    queryClient.setQueryData(key, poll);
    const undo = pollVoteWrite.optimistic?.({ pollId: 'p1', choices: [1] });
    expect(queryClient.getQueryData<PollDTO>(key)).toMatchObject({ myVotes: [1], totalVotes: 4, options: [{ votes: 2 }, { votes: 2 }] });
    undo?.();
    expect(queryClient.getQueryData<PollDTO>(key)).toEqual(poll);
  });
});
