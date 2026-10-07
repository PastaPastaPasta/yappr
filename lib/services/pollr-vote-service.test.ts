import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { Poll } from './pollr-poll-service';

// Exercises the v3/v4/v5 branch points of the ballot service at an in-memory
// SDK boundary: what gets written, what query shape reads it back, and how a
// refused or uncertain write is resolved. No network.
const mocks = vi.hoisted(() => ({ query: vi.fn(), count: vi.fn(), createDocument: vi.fn(), updateDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({ documents: { query: mocks.query, count: mocks.count } }),
}));
vi.mock('./state-transition-service', () => ({
  stateTransitionService: { createDocument: mocks.createDocument, updateDocument: mocks.updateDocument },
}));

const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
const CREATOR = id(1);
const VOTER = id(2);
const HOUR = 3_600_000;

const poll = (overrides: Partial<Poll> = {}): Poll => ({
  id: id(9),
  ownerId: CREATOR,
  createdAt: new Date(0),
  question: 'Which?',
  options: ['alpha', 'bravo', 'charlie'],
  optionCount: 3,
  multiChoice: false,
  ...overrides,
});

async function loadService(topology: 'v3' | 'v4' | 'v5') {
  vi.stubEnv('NEXT_PUBLIC_POLLR_TOPOLOGY', topology);
  const { pollrVoteService } = await import('./pollr-vote-service');
  return pollrVoteService;
}

/** The `where` clause the first `documents.query` call was made with. */
const whereOf = () => mocks.query.mock.calls[0][0].where as unknown[][];

/** A tally without its read time, for exact comparisons. */
function counted<T extends { readAt?: number }>(tally: T | null): Omit<T, 'readAt'> | null {
  if (!tally) return null;
  const rest: Partial<T> = { ...tally };
  delete rest.readAt;
  return rest as Omit<T, 'readAt'>;
}

/** A v5 ballot as `documents.query` returns it. */
const ballotDoc = (slot: number, choice: number | null, revision = 1) => ({
  $id: `ballot-${slot}`,
  $revision: revision,
  slot,
  ...(choice === null ? {} : { choice }),
});
const ballots = (...docs: ReturnType<typeof ballotDoc>[]) => new Map(docs.map((doc) => [doc.$id, doc]));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.createDocument.mockResolvedValue({ success: true, confirmed: true });
  mocks.updateDocument.mockResolvedValue({ success: true });
  mocks.query.mockResolvedValue(new Map());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('v5 ballots', () => {
  const open = (overrides: Partial<Poll> = {}) => poll({ endsAt: Date.now() + HOUR, ...overrides });

  it('creates a first single-choice ballot on slot 0, copying the poll’s bound fields', async () => {
    const service = await loadService('v5');
    const target = open();

    expect(await service.setVote(target, [1], VOTER)).toEqual({ success: true, choices: [1], closed: false, stale: false });
    const [, docType, owner, data] = mocks.createDocument.mock.calls[0];
    expect({ docType, owner }).toEqual({ docType: 'vote', owner: VOTER });
    expect({ ...data, pollId: bs58.encode(data.pollId as Uint8Array) }).toEqual({
      pollId: id(9),
      slot: 0,
      choice: 1,
      pollOptionCount: 3,
      pollMultiChoice: false,
      pollEndsAt: target.endsAt,
    });
    // Planned against a fresh read of the voter's ballots.
    expect(whereOf()).toEqual([['pollId', '==', id(9)], ['$ownerId', '==', VOTER]]);
  });

  it('changes a single-choice vote by replacing the ballot at its current revision', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1, 4)));

    expect((await service.setVote(open(), [2], VOTER)).choices).toEqual([2]);
    expect(mocks.createDocument).not.toHaveBeenCalled();
    const [, docType, documentId, owner, data, revision] = mocks.updateDocument.mock.calls[0];
    expect({ docType, documentId, owner, revision, choice: data.choice, slot: data.slot }).toEqual({
      docType: 'vote', documentId: 'ballot-0', owner: VOTER, revision: 4, choice: 2, slot: 0,
    });
  });

  it('withdraws by replacing the ballot without a choice', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1, 2)));

    expect((await service.setVote(open(), [], VOTER)).choices).toEqual([]);
    const data = mocks.updateDocument.mock.calls[0][4];
    expect(data).not.toHaveProperty('choice');
    expect(data).toMatchObject({ slot: 0, pollOptionCount: 3, pollMultiChoice: false });
  });

  it('multi choice: creates newly ticked options and unticks by replace', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0), ballotDoc(1, null, 3)));

    const result = await service.setVote(open({ multiChoice: true }), [1, 2], VOTER);
    expect(result).toEqual({ success: true, choices: [1, 2], closed: false, stale: false });
    // Untick 0, re-tick 1 (replace), tick 2 (create) — in slot order, one at a time.
    expect(mocks.updateDocument.mock.calls.map((call) => [call[2], call[4].choice ?? null])).toEqual([
      ['ballot-0', null],
      ['ballot-1', 1],
    ]);
    expect(mocks.createDocument.mock.calls.map((call) => [call[3].slot, call[3].choice])).toEqual([[2, 2]]);
  });

  it('writes nothing when the selection is unchanged', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1)));

    expect((await service.setVote(open(), [1], VOTER)).success).toBe(true);
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(mocks.updateDocument).not.toHaveBeenCalled();
  });

  it('refuses a closed poll, a second single choice and a choice past the options before writing', async () => {
    const service = await loadService('v5');
    // Nothing was written, so nothing about the voter's ballots is reported.
    expect(await service.setVote(poll({ endsAt: Date.now() - 1 }), [1], VOTER)).toEqual({
      success: false, closed: true, stale: false, error: 'This poll has closed',
    });
    expect((await service.setVote(open(), [0, 1], VOTER)).success).toBe(false);
    expect((await service.setVote(open(), [3], VOTER)).success).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('reports "closed" when the close rule refuses the write, and re-reads the ballots', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1)));
    mocks.updateDocument.mockResolvedValue({
      success: false,
      error: 'A document of type "vote" breaks its propertyConstraints rule "writtenBeforeClose": it does not hold (code=10422)',
    });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, closed: true, stale: false, choices: [1] });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a stale revision (40106)', 'Document X has invalid revision Some(2). The desired revision is 3 (code=40106)'],
    ['a ballot created elsewhere (40105)', 'Document X has duplicate unique properties ["pollId", "$ownerId", "slot"] with other documents'],
  ])('reports %s as stale so the caller refetches', async (_, error) => {
    const service = await loadService('v5');
    mocks.createDocument.mockResolvedValue({ success: false, error });
    mocks.updateDocument.mockResolvedValue({ success: false, error });
    // The first read predates the other tab's write; the re-read sees it.
    mocks.query.mockResolvedValueOnce(new Map()).mockResolvedValue(ballots(ballotDoc(0, 0, 2)));

    expect(await service.setVote(open(), [1], VOTER)).toMatchObject({ success: false, stale: true, closed: false, choices: [0] });
  });

  it('reports a timed-out replace as unconfirmed, without a re-read or further writes', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0), ballotDoc(1, null)));
    mocks.updateDocument.mockResolvedValue({ success: false, error: 'wait for state transition result timed out' });

    const result = await service.setVote(open({ multiChoice: true }), [1, 2], VOTER);
    expect(result).toMatchObject({ success: false, unconfirmed: true });
    // Leaves the caller's view alone: a read this soon would predate the write.
    expect(result.choices).toBeUndefined();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.updateDocument).toHaveBeenCalledTimes(1);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed create as unconfirmed, not as counted', async () => {
    const service = await loadService('v5');
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });

    expect(await service.setVote(open({ multiChoice: true }), [0, 1], VOTER)).toMatchObject({ success: false, unconfirmed: true });
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
  });

  it('stops at a write held back for a pending transition, then re-reads', async () => {
    const service = await loadService('v5');
    const { PENDING_WRITE_ERROR } = await import('@/lib/error-utils');
    mocks.createDocument.mockResolvedValue({ success: false, error: PENDING_WRITE_ERROR });

    expect(await service.setVote(open({ multiChoice: true }), [0, 1], VOTER)).toMatchObject({ success: false, choices: [] });
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('copies the poll’s stored optionCount, not the options it could read', async () => {
    const service = await loadService('v5');
    await service.setVote(open({ optionCount: 4 }), [1], VOTER);
    expect(mocks.createDocument.mock.calls[0][3]).toMatchObject({ pollOptionCount: 4 });
  });

  it('reports the ballot state unknown when the re-read fails too', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValueOnce(ballots(ballotDoc(0, 1))).mockRejectedValue(new Error('down'));
    mocks.updateDocument.mockResolvedValue({ success: false, error: 'insufficient balance' });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, choices: null, error: 'insufficient balance' });
  });

  it('keeps going past an ordinary failure on an independent multi-choice ballot', async () => {
    const service = await loadService('v5');
    mocks.createDocument
      .mockResolvedValueOnce({ success: false, error: 'insufficient balance' })
      .mockResolvedValue({ success: true });
    mocks.query.mockResolvedValueOnce(new Map()).mockResolvedValue(ballots(ballotDoc(2, 2)));

    expect(await service.setVote(open({ multiChoice: true }), [0, 2], VOTER)).toMatchObject({ success: false, choices: [2] });
    expect(mocks.createDocument).toHaveBeenCalledTimes(2);
  });

  it('castVote is not the v5 path', async () => {
    const service = await loadService('v5');
    expect((await service.castVote(open(), [1], VOTER)).success).toBe(false);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });
});

describe('v5 tallies', () => {
  it('folds a moved vote in as a decrement plus an increment', async () => {
    const service = await loadService('v5');
    const moved = service.applyOptimisticVotes(id(9), { counts: [2, 1, 0], total: 3, readAt: 1 }, [1], [0]);
    expect(moved).toEqual({ counts: [1, 2, 0], total: 3 });
    // The optimistic tally is served from the cache until the next real read.
    expect(await service.getTally(poll({ endsAt: Date.now() + HOUR }))).toEqual({ counts: [1, 2, 0], total: 3 });
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('is final only when read off the chain after the close', async () => {
    await loadService('v5');
    const { tallyIsFinal } = await import('./pollr-vote-service');
    const endsAt = Date.now() - 5 * 60_000;
    const closed = poll({ endsAt });

    expect(tallyIsFinal(closed, { counts: [1, 0, 0], total: 1, readAt: Date.now() })).toBe(true);
    // Read while the poll was still open, or optimistic: ballots could still move.
    expect(tallyIsFinal(closed, { counts: [1, 0, 0], total: 1, readAt: endsAt - 1 })).toBe(false);
    expect(tallyIsFinal(closed, { counts: [1, 0, 0], total: 1 })).toBe(false);
    expect(tallyIsFinal(poll({ endsAt: Date.now() + HOUR }), { counts: [1, 0, 0], total: 1, readAt: Date.now() })).toBe(false);
  });

  it('re-reads a tally cached while the poll was open once it has closed', async () => {
    const service = await loadService('v5');
    const endsAt = Date.now() + 10_000;
    mocks.count.mockResolvedValue(new Map([['80', 1n]]));
    expect(counted(await service.getTally(poll({ endsAt })))).toEqual({ counts: [1, 0, 0], total: 1 });

    // A last-second change lands; the poll closes inside the cache TTL.
    vi.advanceTimersByTime(45_000);
    mocks.count.mockResolvedValue(new Map([['81', 1n]]));
    const tally = await service.getTally(poll({ endsAt }));
    expect(counted(tally)).toEqual({ counts: [0, 1, 0], total: 1 });
    expect(mocks.count).toHaveBeenCalledTimes(2);
    // Never the v3 time-bounded scan: v5 enforces the close on chain.
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe('v3 ballot writes', () => {
  it('sends the poll owner, one immutable document per choice, in the mode’s doctype', async () => {
    const service = await loadService('v3');
    await service.castVote(poll({ multiChoice: true }), [0, 2], VOTER);

    expect(mocks.createDocument).toHaveBeenCalledTimes(2);
    const [, docType, owner, data, options] = mocks.createDocument.mock.calls[0];
    expect({ docType, owner }).toEqual({ docType: 'multiVote', owner: VOTER });
    expect(bs58.encode(data.pollOwnerId as Uint8Array)).toBe(CREATOR);
    expect(options).toBeUndefined();
  });

  it('treats an unconfirmed success as cast — stored writes have real confirmation', async () => {
    const service = await loadService('v3');
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });

    expect(await service.castVote(poll(), [1], VOTER)).toMatchObject({ success: true, created: [1] });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('resolves a duplicate rejection to the choice already on chain', async () => {
    const service = await loadService('v3');
    mocks.createDocument.mockResolvedValue({
      success: false,
      error: 'Document X has duplicate unique properties ["pollId", "$ownerId"] with other documents',
    });
    mocks.query.mockResolvedValue(new Map([['0', { choice: 2 }]]));

    expect(await service.castVote(poll(), [1], VOTER)).toMatchObject({ created: [], alreadyVoted: [2], failed: [] });
  });

  it('recognises a duplicate rejection by consensus code as well as by wording', async () => {
    const service = await loadService('v3');
    mocks.createDocument.mockResolvedValue({ success: false, error: 'broadcast rejected: code=40105' });
    mocks.query.mockResolvedValue(new Map([['0', { choice: 2 }]]));

    expect((await service.castVote(poll(), [1], VOTER)).alreadyVoted).toEqual([2]);
  });

  it('records any other refusal as failed and retryable', async () => {
    const service = await loadService('v3');
    mocks.createDocument.mockResolvedValue({ success: false, error: 'insufficient balance' });

    expect(await service.castVote(poll(), [1], VOTER)).toMatchObject({ success: false, failed: [1], error: 'insufficient balance' });
  });
});

describe('v4 is read-only', () => {
  it('writes nothing', async () => {
    const service = await loadService('v4');
    expect(await service.castVote(poll(), [1], VOTER)).toMatchObject({ success: false, created: [], failed: [1] });
    expect((await service.setVote(poll({ endsAt: Date.now() + HOUR }), [1], VOTER)).success).toBe(false);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('still reads my choices through the byPollChoice `in` walk with its required orderBy', async () => {
    const service = await loadService('v4');
    mocks.query.mockResolvedValue(new Map([
      ['0', { choice: 0 }],
      ['1', { choice: 2 }],
    ]));

    expect(await service.getMyVotes(poll({ multiChoice: true }), VOTER)).toEqual([0, 2]);
    expect(whereOf()).toEqual([
      ['pollId', '==', id(9)],
      ['choice', 'in', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
      ['$ownerId', '==', VOTER],
    ]);
    expect(mocks.query.mock.calls[0][0].orderBy).toEqual([['choice', 'asc']]);
  });
});

describe('ballot reads', () => {
  it('v5 reads my ballots off byPollVoter and keeps only those holding a choice', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0, 2), ballotDoc(1, null, 3), ballotDoc(2, 2)));

    expect(await service.getMyVotes(poll({ multiChoice: true }), VOTER)).toEqual([0, 2]);
    expect(whereOf()).toEqual([['pollId', '==', id(9)], ['$ownerId', '==', VOTER]]);
    expect(mocks.query.mock.calls[0][0]).toMatchObject({
      documentTypeName: 'vote',
      orderBy: [['pollId', 'asc'], ['$ownerId', 'asc'], ['slot', 'asc']],
    });
  });

  it('throws rather than reporting "no votes" when the read fails', async () => {
    const service = await loadService('v5');
    mocks.query.mockRejectedValue(new Error('down'));
    await expect(service.getMyVotes(poll(), VOTER)).rejects.toThrow('down');
  });

  it('v3 keeps the unique-index read', async () => {
    const service = await loadService('v3');
    mocks.query.mockResolvedValue(new Map([['0', { choice: 1 }]]));

    expect(await service.getMyVotes(poll(), VOTER)).toEqual([1]);
    expect(whereOf()).toEqual([['pollId', '==', id(9)], ['$ownerId', '==', VOTER]]);
    expect(mocks.query.mock.calls[0][0].orderBy).toEqual([['pollId', 'asc'], ['$ownerId', 'asc']]);
  });
});

describe('v3 tally after an already-voted refusal', () => {
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

  it('trusts a fresh count that went down', async () => {
    const { reconcileTally } = await import('./pollr-vote-service');
    const stale = { counts: [2, 0, 0], total: 2 };
    expect(reconcileTally({ counts: [1, 0, 0], total: 1 }, stale, [], [0])).toEqual({ counts: [1, 0, 0], total: 1 });
    // Only an option written in this call keeps its optimistic count.
    const optimistic = { counts: [2, 3, 1], total: 6 };
    expect(reconcileTally({ counts: [1, 1, 0], total: 2 }, optimistic, [2], [0, 2])).toEqual({
      counts: [1, 1, 1],
      total: 3,
    });
  });

  it('refreshTally does not restore a remembered choice the fresh read no longer shows', async () => {
    const service = await loadService('v3');
    mocks.count.mockResolvedValue(new Map([['81', 1n]]));
    const stale = { counts: [1, 0, 0], total: 1 };

    expect(counted(await service.refreshTally(poll(), stale, { created: [], alreadyVoted: [1] }))).toEqual({
      counts: [0, 1, 0],
      total: 1,
    });
    expect(counted(await service.getTally(poll()))).toEqual({ counts: [0, 1, 0], total: 1 });
  });

  it.each([
    ['fails', () => mocks.query.mockRejectedValue(new Error('down'))],
    ['finds no ballot', () => mocks.query.mockResolvedValue(new Map())],
  ])('does not invent a single-choice vote when the duplicate’s ballot read %s', async (_, arrangeRead) => {
    const service = await loadService('v3');
    // Another tab voted 0; this tab tried 1 and was refused, but can't read which ballot it hit.
    mocks.createDocument.mockResolvedValue({ success: false, error: 'broadcast rejected: code=40105' });
    arrangeRead();
    mocks.count.mockResolvedValue(new Map([['80', 1n]]));

    const result = await service.castVote(poll(), [1], VOTER);
    expect(result).toMatchObject({ created: [], alreadyVoted: [], failed: [], unresolvedDuplicate: true });
    expect(counted(await service.refreshTally(poll(), { counts: [0, 0, 0], total: 0 }, result))).toEqual({
      counts: [1, 0, 0],
      total: 1,
    });
  });

  it('refreshTally re-reads past the cache and falls back to the optimistic tally on failure', async () => {
    const service = await loadService('v3');
    mocks.count.mockResolvedValue(new Map([['80', 1n], ['81', 1n]]));
    service.applyOptimisticVotes(id(9), { counts: [0, 0, 0], total: 0 }, [1]);

    expect(counted(await service.refreshTally(poll(), { counts: [0, 1, 0], total: 1 }, { created: [], alreadyVoted: [0] }))).toEqual({
      counts: [1, 1, 0],
      total: 2,
    });
    expect(mocks.count).toHaveBeenCalledTimes(1);

    mocks.count.mockRejectedValue(new Error('down'));
    mocks.query.mockRejectedValue(new Error('down'));
    const optimistic = { counts: [0, 1, 0], total: 1 };
    expect(await service.refreshTally(poll(), optimistic, { created: [], alreadyVoted: [0] })).toBe(optimistic);
  });
});

describe('v3 final results on a closed poll', () => {
  const closed = () => poll({ endsAt: Date.now() - 60_000 });
  /** Full pages of option-0 ballots that never run out, each continuing after the last. */
  const endlessFullPages = () => mocks.query.mockImplementation(async ({ startAfter }: { startAfter?: string }) => {
    const first = startAfter ? Number(startAfter.slice(1)) + 1 : 0;
    return new Map(Array.from({ length: 100 }, (_, i) => [`d${first + i}`, { $id: `d${first + i}`, choice: 0 }]));
  });

  it('tallies only the ballots created by the close time, in one read', async () => {
    const service = await loadService('v3');
    // The count tree would include a late option-0 ballot; it is never consulted.
    mocks.count.mockResolvedValue(new Map([['80', 2n], ['81', 1n]]));
    mocks.query.mockResolvedValue(new Map([
      ['a', { choice: 0 }],
      ['b', { choice: 1 }],
    ]));

    expect(counted(await service.getTally(closed()))).toEqual({ counts: [1, 1, 0], total: 2, cutoffVerified: true });
    expect(mocks.count).not.toHaveBeenCalled();
    const onTimeQuery = mocks.query.mock.calls[0][0];
    expect(onTimeQuery.where).toEqual([['pollId', '==', id(9)], ['$createdAt', '<=', closed().endsAt]]);
    expect(onTimeQuery.orderBy).toEqual([['pollId', 'asc'], ['$createdAt', 'asc']]);
  });

  it('reports the tally unavailable, not the unbounded count, when the on-time read fails', async () => {
    const { PollTallyUnavailableError } = await import('./pollr-vote-service');
    const service = await loadService('v3');
    mocks.count.mockResolvedValue(new Map([['80', 2n], ['81', 1n]]));
    mocks.query.mockRejectedValue(new Error('down'));

    await expect(service.getTally(closed())).rejects.toBeInstanceOf(PollTallyUnavailableError);
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('marks a capped on-time read’s count-tree fallback as not final', async () => {
    const service = await loadService('v3');
    // Every page comes back full, so the on-time read hits its pagination cap.
    endlessFullPages();
    mocks.count.mockResolvedValue(new Map([['80', 1001n], ['81', 1n]]));

    expect(counted(await service.getTally(closed()))).toEqual({ counts: [1001, 1, 0], total: 1002, lateIncluded: true });
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

    expect(counted(await service.refreshTally(closed(), optimistic, { created: [2], alreadyVoted: [0] }))).toEqual({
      counts: [1, 1, 0],
      total: 2,
      cutoffVerified: true,
    });
  });

  it('a refresh keeps a capped closed-poll tally marked as not final', async () => {
    const service = await loadService('v3');
    endlessFullPages();
    mocks.count.mockResolvedValue(new Map([['80', 1001n], ['81', 1n]]));

    const refreshed = await service.refreshTally(closed(), { counts: [1001, 1, 1], total: 1003 }, { created: [2], alreadyVoted: [] });
    expect(counted(refreshed)).toEqual({ counts: [1001, 1, 1], total: 1003, lateIncluded: true });
    // The cached copy keeps the flag too.
    expect(await service.getTally(closed())).toMatchObject({ lateIncluded: true });
  });

  it('a failed refresh on a closed poll marks the optimistic tally as not final', async () => {
    const service = await loadService('v3');
    mocks.query.mockRejectedValue(new Error('down'));
    const optimistic = { counts: [1, 1, 1], total: 3 };

    expect(await service.refreshTally(closed(), optimistic, { created: [2], alreadyVoted: [0] })).toEqual({
      ...optimistic,
      lateIncluded: true,
    });
  });

  it('a tally cached while the poll was open is re-read by close time once it closes', async () => {
    const service = await loadService('v3');
    const endsAt = Date.now() + 10_000;
    mocks.count.mockResolvedValue(new Map([['80', 1n]]));
    expect(counted(await service.getTally(poll({ endsAt })))).toEqual({ counts: [1, 0, 0], total: 1 });

    vi.advanceTimersByTime(11_000);
    mocks.query.mockResolvedValue(new Map([['a', { choice: 0 }], ['b', { choice: 1 }]]));
    expect(counted(await service.getTally(poll({ endsAt })))).toEqual({ counts: [1, 1, 0], total: 2, cutoffVerified: true });
  });

  it('only a cutoff-verified tally counts as final results (v4: any not known to include late ballots)', async () => {
    await loadService('v3');
    const { tallyIsFinal } = await import('./pollr-vote-service');
    expect(tallyIsFinal(closed(), { counts: [1, 1, 0], total: 2 })).toBe(false);
    expect(tallyIsFinal(closed(), { counts: [1, 1, 0], total: 2, lateIncluded: true })).toBe(false);
    expect(tallyIsFinal(closed(), { counts: [1, 1, 0], total: 2, cutoffVerified: true })).toBe(true);
    // Nothing is final while the poll is open.
    expect(tallyIsFinal(poll({ endsAt: Date.now() + 60_000 }), { counts: [1, 1, 0], total: 2, cutoffVerified: true })).toBe(false);

    vi.resetModules();
    await loadService('v4');
    const v4 = await import('./pollr-vote-service');
    expect(v4.tallyIsFinal(closed(), { counts: [1, 1, 0], total: 2 })).toBe(true);
    expect(v4.tallyIsFinal(closed(), { counts: [1, 1, 0], total: 2, lateIncluded: true })).toBe(false);
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
