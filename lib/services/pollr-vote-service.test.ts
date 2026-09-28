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
  it('v4 binds pollOwnerId to the poll’s $ownerId and confirms by affected state', async () => {
    const service = await loadService('v4');
    // Consensus binds the ballot to the poll's OWNER, so that — not the
    // caller's idea of a creator — is the only value that can be sent.
    const result = await service.castVote(poll({ ownerId: IMPOSTOR }), [1], VOTER);

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

describe('tally after an already-voted refusal', () => {
  it('counts the voter’s earlier ballot that a stale tally was missing', async () => {
    const { reconcileTally } = await import('./pollr-vote-service');
    // The stale tab saw only Black; the voter's Green ballot came from another tab.
    const stale = { counts: [0, 1, 0], total: 1 };
    expect(reconcileTally({ counts: [1, 1, 0], total: 2 }, stale, [], [0])).toEqual({ counts: [1, 1, 0], total: 2 });
    // The count tree still lags: the voter's own recorded choice is never shown at 0.
    expect(reconcileTally({ counts: [0, 1, 0], total: 1 }, stale, [], [0])).toEqual({ counts: [1, 1, 0], total: 2 });
  });

  it('keeps just-written selections the count tree has not caught up with', async () => {
    const { reconcileTally } = await import('./pollr-vote-service');
    // Multi-choice: the new pick (3) landed in this call, the fresh read predates it.
    const optimistic = { counts: [1, 0, 1, 1], total: 3 };
    expect(reconcileTally({ counts: [1, 1, 1, 0], total: 3 }, optimistic, [3], [0, 1, 2, 3])).toEqual({
      counts: [1, 1, 1, 1],
      total: 4,
    });
  });

  it('trusts a fresh count that went down: ballots can be deleted', async () => {
    const { reconcileTally } = await import('./pollr-vote-service');
    // The stale tab saw two votes for Black; another voter has since deleted theirs.
    const stale = { counts: [2, 0, 0], total: 2 };
    expect(reconcileTally({ counts: [1, 0, 0], total: 1 }, stale, [], [0])).toEqual({ counts: [1, 0, 0], total: 1 });
    // Only an option written in this call keeps its optimistic count.
    const optimistic = { counts: [2, 3, 1], total: 6 };
    expect(reconcileTally({ counts: [1, 1, 0], total: 2 }, optimistic, [2], [0, 2])).toEqual({
      counts: [1, 1, 1],
      total: 3,
    });
  });

  it('refreshTally re-reads past the cache and falls back to the optimistic tally on failure', async () => {
    const service = await loadService('v4');
    mocks.count.mockResolvedValue(new Map([['80', 1n], ['81', 1n]]));
    service.applyOptimisticVotes(id(9), { counts: [0, 0, 0], total: 0 }, [1]);

    expect(await service.refreshTally(poll(), { counts: [0, 1, 0], total: 1 }, [], [0])).toEqual({
      counts: [1, 1, 0],
      total: 2,
    });
    expect(mocks.count).toHaveBeenCalledTimes(1);

    mocks.count.mockRejectedValue(new Error('down'));
    mocks.query.mockRejectedValue(new Error('down'));
    const optimistic = { counts: [0, 1, 0], total: 1 };
    expect(await withoutWaiting(service.refreshTally(poll(), optimistic, [], [0]))).toBe(optimistic);
  });
});

describe('final results on a closed poll', () => {
  const closed = () => poll({ endsAt: Date.now() - 60_000 });

  it('v3 tallies only the ballots created by the close time, in one read', async () => {
    const service = await loadService('v3');
    // The count tree would include a late option-0 ballot; it is never consulted.
    mocks.count.mockResolvedValue(new Map([['80', 2n], ['81', 1n]]));
    mocks.query.mockResolvedValue(new Map([
      ['a', { choice: 0 }],
      ['b', { choice: 1 }],
    ]));

    expect(await service.getTally(closed())).toEqual({ counts: [1, 1, 0], total: 2, cutoffVerified: true });
    expect(mocks.count).not.toHaveBeenCalled();
    const onTimeQuery = mocks.query.mock.calls[0][0];
    expect(onTimeQuery.where).toEqual([['pollId', '==', id(9)], ['$createdAt', '<=', closed().endsAt]]);
    expect(onTimeQuery.orderBy).toEqual([['pollId', 'asc'], ['$createdAt', 'asc']]);
  });

  it('v3 reports the tally unavailable, not the unbounded count, when the on-time read fails', async () => {
    const { PollTallyUnavailableError } = await import('./pollr-vote-service');
    const service = await loadService('v3');
    // The count tree includes a late ballot; showing it as final would let a
    // transient error change "Final results".
    mocks.count.mockResolvedValue(new Map([['80', 2n], ['81', 1n]]));
    mocks.query.mockRejectedValue(new Error('down'));

    await expect(service.getTally(closed())).rejects.toBeInstanceOf(PollTallyUnavailableError);
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('v3 marks a capped on-time read’s count-tree fallback as not final', async () => {
    const service = await loadService('v3');
    // Every page comes back full, so the on-time read hits its pagination cap.
    const fullPage = new Map(Array.from({ length: 100 }, (_, i) => [`d${i}`, { $id: `d${i}`, choice: 0 }]));
    mocks.query.mockResolvedValue(fullPage);
    mocks.count.mockResolvedValue(new Map([['80', 1001n], ['81', 1n]]));

    expect(await service.getTally(closed())).toEqual({ counts: [1001, 1, 0], total: 1002, lateIncluded: true });
    // The flag survives the cache, so a later load can't relabel it final.
    expect(await service.getTally(closed())).toMatchObject({ lateIncluded: true });

    vi.resetModules();
    const open = await loadService('v3');
    mocks.count.mockResolvedValue(new Map([['80', 2n]]));
    expect(await open.getTally(poll({ endsAt: Date.now() + 60_000 }))).not.toHaveProperty('lateIncluded');
  });

  it('a refresh after an already-voted refusal adds no late ballot to a cutoff-verified tally', async () => {
    const service = await loadService('v3');
    // The voter's option-2 pick was written after the close, so the on-time read leaves it out.
    mocks.query.mockResolvedValue(new Map([['a', { choice: 0 }], ['b', { choice: 1 }]]));
    const optimistic = { counts: [1, 1, 1], total: 3 };

    expect(await service.refreshTally(closed(), optimistic, [2], [0, 2])).toEqual({
      counts: [1, 1, 0],
      total: 2,
      cutoffVerified: true,
    });
  });

  it('a refresh keeps a capped closed-poll tally marked as not final', async () => {
    const service = await loadService('v3');
    const fullPage = new Map(Array.from({ length: 100 }, (_, i) => [`d${i}`, { $id: `d${i}`, choice: 0 }]));
    mocks.query.mockResolvedValue(fullPage);
    mocks.count.mockResolvedValue(new Map([['80', 1001n], ['81', 1n]]));

    const refreshed = await service.refreshTally(closed(), { counts: [1001, 1, 1], total: 1003 }, [2], [2]);
    expect(refreshed).toEqual({ counts: [1001, 1, 1], total: 1003, lateIncluded: true });
    // The cached copy keeps the flag too.
    expect(await service.getTally(closed())).toMatchObject({ lateIncluded: true });
  });

  it('a failed refresh on a closed v3 poll marks the optimistic tally as not final', async () => {
    const service = await loadService('v3');
    mocks.query.mockRejectedValue(new Error('down'));
    // The optimistic tally holds a selection written after the close.
    const optimistic = { counts: [1, 1, 1], total: 3 };

    expect(await withoutWaiting(service.refreshTally(closed(), optimistic, [2], [0, 2]))).toEqual({
      ...optimistic,
      lateIncluded: true,
    });
  });

  it('a tally cached while the poll was open is re-read by close time once it closes', async () => {
    const service = await loadService('v3');
    const endsAt = Date.now() + 10_000;
    mocks.count.mockResolvedValue(new Map([['80', 1n]]));
    expect(await service.getTally(poll({ endsAt }))).toEqual({ counts: [1, 0, 0], total: 1 });

    // A second on-time ballot lands; the poll closes inside the cache TTL.
    vi.advanceTimersByTime(11_000);
    mocks.query.mockResolvedValue(new Map([['a', { choice: 0 }], ['b', { choice: 1 }]]));
    expect(await service.getTally(poll({ endsAt }))).toEqual({ counts: [1, 1, 0], total: 2, cutoffVerified: true });
  });

  it('does not bound by close time while the poll is open, or on v4', async () => {
    const v3 = await loadService('v3');
    mocks.count.mockResolvedValue(new Map([['80', 2n]]));
    await v3.getTally(poll({ endsAt: Date.now() + 60_000 }));
    expect(mocks.query).not.toHaveBeenCalled();

    vi.resetModules();
    const v4 = await loadService('v4');
    await v4.getTally(closed());
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
