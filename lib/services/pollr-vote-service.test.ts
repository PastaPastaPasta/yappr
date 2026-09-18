import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { Poll } from './pollr-poll-service';

// Exercises the v3/v4 branch points of the ballot service at an in-memory SDK
// boundary: what gets written, what query shape reads it back, and how a
// post-broadcast failure on an indexOnly write is resolved. No network.
const mocks = vi.hoisted(() => ({ query: vi.fn(), count: vi.fn(), ranked: vi.fn(), createDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({ documents: { query: mocks.query, count: mocks.count, ranked: mocks.ranked } }),
}));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument: mocks.createDocument } }));

const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
const CREATOR = id(1);
const VOTER = id(2);
const IMPOSTOR = id(3);

const poll = (overrides: Partial<Poll> = {}): Poll => ({
  id: id(9),
  ownerId: CREATOR,
  createdAt: new Date(0),
  question: 'Which?',
  options: ['alpha', 'bravo', 'charlie'],
  multiChoice: false,
  author: CREATOR,
  authorIsOwner: true,
  ...overrides,
});

async function loadService(topology: 'v3' | 'v4') {
  vi.stubEnv('NEXT_PUBLIC_POLLR_TOPOLOGY', topology);
  const { pollrVoteService } = await import('./pollr-vote-service');
  return pollrVoteService;
}

/** The `where` clause the single `documents.query` call was made with. */
const whereOf = () => mocks.query.mock.calls[0][0].where as unknown[][];

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.createDocument.mockResolvedValue({ success: true, confirmed: true });
  mocks.query.mockResolvedValue(new Map());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Runs `work` with the entry-probe's retry sleeps fast-forwarded. */
async function withoutWaiting<T>(work: Promise<T>): Promise<T> {
  const settled = work.finally(() => {});
  await vi.runAllTimersAsync();
  return settled;
}

describe('ballot writes', () => {
  it('v4 binds pollOwnerId to the poll’s attested author and confirms by affected state', async () => {
    const service = await loadService('v4');
    // A poll whose author is NOT its owner: consensus binds the ballot to
    // `author`, so sending `ownerId` here would be rejected with 40127.
    const result = await service.castVote(poll({ ownerId: IMPOSTOR, author: IMPOSTOR }), [1], VOTER);

    expect(result.created).toEqual([1]);
    const [contractId, docType, owner, data, options] = mocks.createDocument.mock.calls[0];
    expect({ contractId: typeof contractId, docType, owner }).toEqual({ contractId: 'string', docType: 'vote', owner: VOTER });
    expect(bs58.encode(data.pollOwnerId as Uint8Array)).toBe(IMPOSTOR);
    expect(options).toEqual({ confirmation: 'affectedState' });
  });

  it('v3 sends the poll owner and no indexOnly confirmation mode', async () => {
    const service = await loadService('v3');
    await service.castVote(poll({ multiChoice: true }), [0, 2], VOTER);

    expect(mocks.createDocument).toHaveBeenCalledTimes(2);
    const [, docType, , data, options] = mocks.createDocument.mock.calls[0];
    expect(docType).toBe('multiVote');
    expect(bs58.encode(data.pollOwnerId as Uint8Array)).toBe(CREATOR);
    expect(options).toBeUndefined();
  });

  it('refuses to vote on a poll that attests an author it does not own', async () => {
    const service = await loadService('v4');
    const result = await service.castVote(poll({ author: IMPOSTOR, authorIsOwner: false }), [0], VOTER);

    expect(result).toMatchObject({ success: false, created: [], failed: [0] });
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('believes the chain over a v4 create that fails after the broadcast landed', async () => {
    const service = await loadService('v4');
    mocks.createDocument.mockResolvedValue({ success: false, error: 'wait for state transition result timed out' });
    // The entry probe finds it: the write landed despite the reported failure.
    mocks.query.mockResolvedValue(new Map([['0', { pollId: id(9), choice: 1, $ownerId: VOTER }]]));

    const result = await withoutWaiting(service.castVote(poll(), [1], VOTER));
    expect(result).toMatchObject({ success: true, created: [1], failed: [] });
    expect(whereOf()).toEqual([['pollId', '==', id(9)], ['choice', '==', 1], ['$ownerId', '==', VOTER]]);
  });

  it('does not report an UNCONFIRMED v4 success the chain cannot show as a cast ballot', async () => {
    const service = await loadService('v4');
    // What createDocument returns when the confirmation wait times out: its own
    // landed-check is a get-by-id, which an indexOnly doctype can never answer.
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });
    mocks.query.mockResolvedValue(new Map());

    const result = await withoutWaiting(service.castVote(poll(), [1], VOTER));
    expect(result).toMatchObject({ success: false, created: [], failed: [1] });
    expect(mocks.query).toHaveBeenCalled();
  });

  it('accepts an unconfirmed v4 success once the entry is readable', async () => {
    const service = await loadService('v4');
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });
    mocks.query
      .mockResolvedValueOnce(new Map())
      .mockResolvedValue(new Map([['0', { pollId: id(9), choice: 1, $ownerId: VOTER }]]));

    const result = await withoutWaiting(service.castVote(poll(), [1], VOTER));
    expect(result).toMatchObject({ success: true, created: [1] });
  });

  it('treats a v3 unconfirmed success as cast — stored writes have real confirmation', async () => {
    const service = await loadService('v3');
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });

    const result = await service.castVote(poll(), [1], VOTER);
    expect(result).toMatchObject({ success: true, created: [1] });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('does not launder a duplicate rejection into a successful vote', async () => {
    const service = await loadService('v4');
    mocks.createDocument.mockResolvedValue({
      success: false,
      error: 'Document X has duplicate unique properties ["pollId", "$ownerId"] with other documents',
    });
    // The voter's EARLIER ballot — the entry probe would find it, so the
    // duplicate check has to run first or this reads as a fresh vote.
    mocks.query.mockResolvedValue(new Map([['0', { pollId: id(9), choice: 2, $ownerId: VOTER }]]));

    const result = await service.castVote(poll(), [1], VOTER);
    expect(result.created).toEqual([]);
    expect(result.alreadyVoted).toEqual([2]);
  });

  it('recognises a duplicate rejection by consensus code as well as by wording', async () => {
    const service = await loadService('v4');
    mocks.createDocument.mockResolvedValue({ success: false, error: 'broadcast rejected: code=40105' });
    mocks.query.mockResolvedValue(new Map([['0', { pollId: id(9), choice: 2, $ownerId: VOTER }]]));

    const result = await service.castVote(poll(), [1], VOTER);
    expect(result.created).toEqual([]);
    expect(result.alreadyVoted).toEqual([2]);
  });
});

describe('ballot reads', () => {
  it('v4 reads my choices through the byPollChoice `in` walk with its required orderBy', async () => {
    const service = await loadService('v4');
    mocks.query.mockResolvedValue(new Map([
      ['0', { choice: 0 }],
      ['1', { choice: 2 }],
    ]));

    expect(await service.getMyVotes(poll({ multiChoice: true }), VOTER)).toEqual([0, 2]);
    // The full 0-9 range, not the poll's three options: a ballot for an
    // out-of-range choice still blocks the voter, so it must be visible here.
    expect(whereOf()).toEqual([
      ['pollId', '==', id(9)],
      ['choice', 'in', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
      ['$ownerId', '==', VOTER],
    ]);
    expect(mocks.query.mock.calls[0][0].orderBy).toEqual([['choice', 'asc']]);
  });

  it('v3 keeps the unique-index read', async () => {
    const service = await loadService('v3');
    mocks.query.mockResolvedValue(new Map([['0', { choice: 1 }]]));

    expect(await service.getMyVotes(poll(), VOTER)).toEqual([1]);
    expect(whereOf()).toEqual([['pollId', '==', id(9)], ['$ownerId', '==', VOTER]]);
    expect(mocks.query.mock.calls[0][0].orderBy).toEqual([['pollId', 'asc'], ['$ownerId', 'asc']]);
  });

  it('v4 reads the winner off the ranked secondary; v3 has no such index', async () => {
    const service = await loadService('v4');
    // Ranked pages hand integer group values back decoded, unlike grouped counts.
    mocks.ranked.mockResolvedValue({ entries: [{ groupValue: 2, value: 5n }] });

    expect(await service.getWinner(poll())).toEqual({ choice: 2, count: 5 });
    expect(mocks.ranked.mock.calls[0][0]).toMatchObject({
      documentTypeName: 'vote',
      groupBy: 'choice',
      aggregate: { type: 'count' },
      where: [['pollId', '==', id(9)]],
      limit: 1,
    });

    vi.resetModules();
    const v3 = await loadService('v3');
    expect(await v3.getWinner(poll())).toBeNull();
  });

  it('returns no winner for a poll nobody has voted on', async () => {
    const service = await loadService('v4');
    mocks.ranked.mockResolvedValue({ entries: [] });
    expect(await service.getWinner(poll())).toBeNull();
  });
});
