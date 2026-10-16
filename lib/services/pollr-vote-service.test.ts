import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { Poll } from './pollr-poll-service';

// Exercises the v3/v4/v7 branch points of the ballot service at an in-memory
// SDK boundary: what gets written, what query shape reads it back, and how a
// refused or uncertain write is resolved. No network.
const mocks = vi.hoisted(() => ({
  query: vi.fn(), count: vi.fn(), createDocument: vi.fn(), updateDocument: vi.fn(), settle: vi.fn(),
  loadReservation: vi.fn(), contractNonce: vi.fn(), getDocument: vi.fn(), deleteDocument: vi.fn(),
}));
vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({
    documents: { query: mocks.query, count: mocks.count, get: mocks.getDocument },
    identities: { contractNonce: mocks.contractNonce },
  }),
}));
// The real reservation rules (stillPending) over a mocked store.
vi.mock('./identity-nonce', async (load) => ({
  ...(await load<typeof import('./identity-nonce')>()),
  settlePendingWrites: mocks.settle,
  loadReservation: mocks.loadReservation,
}));
vi.mock('./state-transition-service', () => ({
  stateTransitionService: { createDocument: mocks.createDocument, updateDocument: mocks.updateDocument, deleteDocument: mocks.deleteDocument },
}));

// The uncertain-replace record lives in localStorage; an in-memory one here.
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});

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
  multiChoice: false,
  ...overrides,
});

async function loadService(topology: 'v3' | 'v4' | 'v7') {
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

/** A v7 ballot as `documents.query` returns it; null choices = withdrawn. */
const ballotDoc = (choices: number[] | null, revision = 1) => ({
  $id: 'ballot',
  $revision: revision,
  ...(choices === null ? {} : { choices }),
});
const ballots = (doc: ReturnType<typeof ballotDoc>) => new Map([[doc.$id, doc]]);

/** The data of the first create, with its pollId bytes as base58. */
function created(): Record<string, unknown> {
  const data = mocks.createDocument.mock.calls[0][3] as Record<string, unknown>;
  return { ...data, pollId: bs58.encode(data.pollId as Uint8Array) };
}

const TIMED_OUT = 'wait for state transition result timed out';
const CLOSED_40127 = 'Document X: the referenced poll does not satisfy where on pollId (endsAt) (code=40127)';

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.createDocument.mockResolvedValue({ success: true, confirmed: true });
  mocks.updateDocument.mockResolvedValue({ success: true });
  mocks.query.mockResolvedValue(new Map());
  mocks.settle.mockResolvedValue(0);
  mocks.loadReservation.mockReturnValue(null);
  storage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const open = (overrides: Partial<Poll> = {}) => poll({ endsAt: Date.now() + HOUR, ...overrides });

describe('v7 ballot writes', () => {
  it('creates a first ballot holding just the poll and the choice, planned off byPollVoter', async () => {
    const service = await loadService('v7');

    expect(await service.setVote(open(), [1], VOTER)).toEqual({ success: true, choices: [1], closed: false, stale: false });
    const [, docType, owner] = mocks.createDocument.mock.calls[0];
    expect({ docType, owner }).toEqual({ docType: 'vote', owner: VOTER });
    expect(created()).toEqual({ pollId: id(9), choices: [1] });
    // Planned against a fresh read of the voter's one ballot.
    expect(mocks.query.mock.calls[0][0]).toMatchObject({
      documentTypeName: 'vote',
      where: [['pollId', '==', id(9)], ['$ownerId', '==', VOTER]],
      orderBy: [['pollId', 'asc'], ['$ownerId', 'asc']],
      limit: 1,
    });
  });

  it('casts a first multi-choice vote as one ballot holding every pick', async () => {
    const service = await loadService('v7');

    expect((await service.setVote(open({ multiChoice: true }), [2, 0], VOTER)).choices).toEqual([0, 2]);
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
    expect(created()).toEqual({ pollId: id(9), choices: [0, 2] });
  });

  it('changes a vote by replacing the ballot at its current revision', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([1], 4)));

    expect((await service.setVote(open(), [2], VOTER)).choices).toEqual([2]);
    expect(mocks.createDocument).not.toHaveBeenCalled();
    const [, docType, documentId, owner, data, revision] = mocks.updateDocument.mock.calls[0];
    expect({ docType, documentId, owner, revision, choices: data.choices }).toEqual({
      docType: 'vote', documentId: 'ballot', owner: VOTER, revision: 4, choices: [2],
    });
  });

  it('ticks and unticks multi-choice options in one replace', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([0, 1], 2)));

    expect(await service.setVote(open({ multiChoice: true }), [1, 2], VOTER)).toEqual({ success: true, choices: [1, 2], closed: false, stale: false });
    expect(mocks.updateDocument).toHaveBeenCalledTimes(1);
    expect(mocks.updateDocument.mock.calls[0][4].choices).toEqual([1, 2]);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('withdraws by replacing the ballot without choices', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([0, 2], 2)));

    expect((await service.setVote(open({ multiChoice: true }), [], VOTER)).choices).toEqual([]);
    const data = mocks.updateDocument.mock.calls[0][4];
    // An empty array is refused by the contract: withdrawing leaves the field out.
    expect(Object.keys(data)).toEqual(['pollId']);
  });

  it('re-picks on a withdrawn ballot by replacing it, never creating a second', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc(null, 3)));

    expect((await service.setVote(open(), [0], VOTER)).success).toBe(true);
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(mocks.updateDocument.mock.calls[0][4].choices).toEqual([0]);
    expect(mocks.updateDocument.mock.calls[0][5]).toBe(3);
  });

  it('reads choices off a typed array view, and refuses to plan over a ballot it cannot read', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(new Map([['ballot', { $id: 'ballot', $revision: 2, choices: Uint8Array.of(2, 0) }]]));
    expect(await service.getMyBallot(open(), VOTER)).toEqual({ id: 'ballot', revision: 2, choices: [0, 2] });

    mocks.query.mockResolvedValue(new Map([['ballot', { $id: 'ballot', $revision: 2, choices: 'garbled' }]]));
    const result = await service.setVote(open(), [1], VOTER);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Couldn't read your ballot/);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('writes nothing when the selection is unchanged', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([1])));

    expect(await service.setVote(open(), [1], VOTER)).toEqual({ success: true, choices: [1], closed: false, stale: false });
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(mocks.updateDocument).not.toHaveBeenCalled();
  });

  it('refuses a closed poll, a second single choice and a choice past the options before writing', async () => {
    const service = await loadService('v7');
    // Nothing was written, so nothing about the voter's ballot is reported.
    expect(await service.setVote(poll({ endsAt: Date.now() - 1 }), [1], VOTER)).toEqual({
      success: false, closed: true, stale: false, error: 'This poll has closed',
    });
    expect((await service.setVote(open(), [0, 1], VOTER)).success).toBe(false);
    expect((await service.setVote(open(), [3], VOTER)).success).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('reports "closed" when the reference’s close condition refuses a replace (40127), and re-reads', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([1])));
    mocks.updateDocument.mockResolvedValue({ success: false, error: CLOSED_40127 });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, closed: true, stale: false, choices: [1] });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('reports "closed" for the mismatch in prose when it names endsAt', async () => {
    const service = await loadService('v7');
    mocks.createDocument.mockResolvedValue({
      success: false,
      error: 'ReferencedDocumentPropertyMismatchError: vote.pollId does not satisfy endsAt >= $updatedAt',
    });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, closed: true, stale: false, choices: [] });
  });

  it('no longer maps a property-rule refusal (10422) as closed', async () => {
    const service = await loadService('v7');
    const error = 'A document of type "vote" breaks its propertyConstraints rule "singleChoice" (code=10422)';
    mocks.createDocument.mockResolvedValue({ success: false, error });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, closed: false, stale: false, choices: [], error });
  });

  it.each([
    ['a stale revision (40106)', 'Document X has invalid revision Some(2). The desired revision is 3 (code=40106)'],
    ['a ballot created elsewhere (40105)', 'Document X has duplicate unique properties ["pollId", "$ownerId"] with other documents'],
  ])('reports %s as stale so the caller refetches', async (_, error) => {
    const service = await loadService('v7');
    mocks.createDocument.mockResolvedValue({ success: false, error });
    // The first read predates the other tab's write; the re-read sees it.
    mocks.query.mockResolvedValueOnce(new Map()).mockResolvedValue(ballots(ballotDoc([0], 2)));

    expect(await service.setVote(open(), [1], VOTER)).toMatchObject({ success: false, stale: true, closed: false, choices: [0] });
  });

  it('reports a deleted poll (40120) as gone, without a re-read', async () => {
    const service = await loadService('v7');
    const error = 'Referenced document poll X not found for path pollId (code=40120)';
    mocks.createDocument.mockResolvedValue({ success: false, error });

    expect(await service.setVote(open({ multiChoice: true }), [0, 1, 2], VOTER)).toEqual({
      success: false, gone: true, closed: false, stale: false, error,
    });
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('reports a timed-out replace as unconfirmed, without a re-read', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([0])));
    mocks.updateDocument.mockResolvedValue({ success: false, error: TIMED_OUT });

    const result = await service.setVote(open({ multiChoice: true }), [1, 2], VOTER);
    expect(result).toMatchObject({ success: false, unconfirmed: true });
    // Leaves the caller's view alone: a read this soon would predate the write.
    expect(result.choices).toBeUndefined();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('reports an unconfirmed create as unconfirmed, not as counted', async () => {
    const service = await loadService('v7');
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });

    expect(await service.setVote(open({ multiChoice: true }), [0, 1], VOTER)).toMatchObject({ success: false, unconfirmed: true });
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
  });

  it('settles a timed-out replace that landed before the next edit writes', async () => {
    const service = await loadService('v7');
    const order: string[] = [];
    mocks.settle.mockImplementation(async () => { order.push('settle'); return 0; });
    mocks.query.mockImplementation(async () => { order.push('read'); return ballots(ballotDoc([1])); });
    mocks.updateDocument.mockImplementation(async () => {
      order.push('replace');
      return { success: false, error: TIMED_OUT };
    });

    // The first edit times out: it reports unconfirmed and leaves the reservation.
    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ unconfirmed: true });

    // It landed. The next edit releases that reservation first, then plans
    // against the ballot at its new revision and writes.
    mocks.settle.mockImplementation(async () => { order.push('settle'); return 1; });
    // The chain shows the ballot at the revision the replace wrote, so its record clears too.
    mocks.getDocument.mockResolvedValue({ $revision: 2 });
    mocks.query.mockImplementation(async () => { order.push('read'); return ballots(ballotDoc([2], 2)); });
    mocks.updateDocument.mockImplementation(async () => { order.push('replace'); return { success: true }; });
    expect(await service.setVote(open(), [0], VOTER)).toEqual({ success: true, choices: [0], closed: false, stale: false });

    expect(order).toEqual(['settle', 'read', 'replace', 'settle', 'read', 'replace']);
    expect(mocks.settle).toHaveBeenCalledWith(VOTER, expect.any(String));
    expect(mocks.updateDocument.mock.calls[1][5]).toBe(2);
  });

  it('still votes when settling pending replaces fails', async () => {
    const service = await loadService('v7');
    mocks.settle.mockRejectedValue(new Error('down'));

    expect((await service.setVote(open(), [1], VOTER)).success).toBe(true);
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
  });

  it('holds back even a no-write selection while an unconfirmed create could still land', async () => {
    const service = await loadService('v7');
    const target = open({ multiChoice: true });
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });
    expect(await service.setVote(target, [0, 1], VOTER)).toMatchObject({ unconfirmed: true });

    // That create is still reserved at its nonce (6) and Platform has not consumed it.
    mocks.loadReservation.mockReturnValue({
      mark: BigInt(6),
      pending: [{ id: 'create', nonce: BigInt(6), expiresAt: null, scope: `pollr-vote:${id(9)}` }],
    });
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    // The chain shows no ballot, so "none" plans no write, yet the create can still land.
    mocks.createDocument.mockClear();
    mocks.query.mockClear();

    expect(await service.setVote(target, [], VOTER)).toMatchObject({ success: false, heldBack: true });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createDocument).not.toHaveBeenCalled();

    // Once its nonce is consumed (it landed or never will), the same selection goes through.
    mocks.contractNonce.mockResolvedValue(BigInt(6));
    expect(await service.setVote(target, [], VOTER)).toEqual({ success: true, choices: [], closed: false, stale: false });
  });

  it('still holds back behind an aged, unconsumed create', async () => {
    const service = await loadService('v7');
    mocks.loadReservation.mockReturnValue({
      mark: BigInt(6),
      pending: [{ id: 'create', nonce: BigInt(6), expiresAt: null, scope: `pollr-vote:${id(9)}` }],
    });
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    // An hour later its nonce is still unconsumed, so it can still land.
    vi.setSystemTime(Date.now() + HOUR);

    expect(await service.setVote(open(), [0], VOTER)).toMatchObject({ success: false, heldBack: true });
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(mocks.updateDocument).not.toHaveBeenCalled();
  });

  it('refuses to plan when the reservation store is unreadable', async () => {
    const service = await loadService('v7');
    const { NONCE_STORE_ERROR } = await import('@/lib/error-utils');
    mocks.loadReservation.mockImplementation(() => { throw new Error(NONCE_STORE_ERROR); });
    mocks.query.mockResolvedValue(ballots(ballotDoc([0])));

    expect(await service.setVote(open(), [0], VOTER)).toEqual({
      success: false, closed: false, stale: false, error: NONCE_STORE_ERROR,
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('reserves the write with its poll’s scope', async () => {
    const service = await loadService('v7');
    const scope = `pollr-vote:${id(9)}`;
    await service.setVote(open(), [1], VOTER);
    expect(mocks.createDocument.mock.calls[0][4]).toEqual({ reservationScope: scope });

    mocks.query.mockResolvedValue(ballots(ballotDoc([1], 3)));
    await service.setVote(open(), [2], VOTER);
    expect(mocks.updateDocument.mock.calls[0][6]).toBe(scope);
  });

  it('reports a replace refused without a verdict as pending, not as settled', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([1], 2)));
    // A transport failure: withSdkSignedWrite keeps its reservation pending.
    mocks.updateDocument.mockImplementation(async () => {
      mocks.loadReservation.mockReturnValue({ mark: BigInt(0), pending: [{ id: 'r', nonce: null, expiresAt: Date.now() + HOUR, scope: `pollr-vote:${id(9)}` }] });
      return { success: false, error: 'fetch failed' };
    });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, unconfirmed: true, error: 'fetch failed' });
  });

  it('treats a replace refused without a verdict as possibly in flight, by its record', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([1])));
    mocks.getDocument.mockResolvedValue({ $revision: 1 });
    mocks.updateDocument.mockResolvedValue({ success: false, error: 'insufficient balance' });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, unconfirmed: true });
  });

  it('holds back a vote whose write waits on another poll’s pending write', async () => {
    const service = await loadService('v7');
    const { PENDING_WRITE_ERROR } = await import('@/lib/error-utils');
    mocks.query.mockResolvedValue(ballots(ballotDoc([1], 2)));
    mocks.updateDocument.mockResolvedValue({ success: false, error: PENDING_WRITE_ERROR });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, heldBack: true });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('holds a no-write selection behind an aged, unconfirmed replace until its revision is proven', async () => {
    const service = await loadService('v7');
    const target = open();
    // 0 -> 1 goes out as a replace (writing revision 3) and times out.
    mocks.query.mockResolvedValue(ballots(ballotDoc([0], 2)));
    mocks.updateDocument.mockResolvedValue({ success: false, error: TIMED_OUT });
    expect(await service.setVote(target, [1], VOTER)).toMatchObject({ unconfirmed: true });

    // 30 minutes on, the nonce store no longer holds it, and the ballot still reads 0 at revision 2.
    vi.setSystemTime(Date.now() + 30 * 60_000);
    mocks.getDocument.mockResolvedValue({ $revision: 2 });
    mocks.updateDocument.mockClear();
    expect(await service.setVote(target, [0], VOTER)).toMatchObject({ success: false, heldBack: true });
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [0], pending: true });
    expect(mocks.updateDocument).not.toHaveBeenCalled();

    // The ballot reaches revision 3 (the replace landed): settled, and it reads 1.
    mocks.getDocument.mockResolvedValue({ $revision: 3 });
    mocks.query.mockResolvedValue(ballots(ballotDoc([1], 3)));
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [1], pending: false });
  });

  it('clears the replace record on a confirmed replace and on a consensus refusal', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([0], 2)));
    expect((await service.setVote(open(), [1], VOTER)).success).toBe(true);
    expect(await service.getBallotState(open(), VOTER)).toMatchObject({ pending: false });

    mocks.updateDocument.mockResolvedValue({ success: false, error: 'Document X has invalid revision Some(2) (code=40106)' });
    await service.setVote(open(), [1], VOTER);
    expect(await service.getBallotState(open(), VOTER)).toMatchObject({ pending: false });
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it('reports the ballot state unknown when the re-read fails too', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValueOnce(ballots(ballotDoc([1]))).mockRejectedValue(new Error('down'));
    // A consensus refusal: a verdict, so nothing is left in flight.
    const refusal = 'Identity has insufficient balance (code=40001)';
    mocks.updateDocument.mockResolvedValue({ success: false, error: refusal });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, choices: null, error: refusal });
  });

  it('castVote is not the v7 path', async () => {
    const service = await loadService('v7');
    expect((await service.castVote(open(), [1], VOTER)).success).toBe(false);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });
});

describe('v7 ballot state', () => {
  it('reads the ballot only after the settle and the pending check', async () => {
    const service = await loadService('v7');
    const order: string[] = [];
    mocks.settle.mockImplementation(async () => { order.push('settle'); return 0; });
    mocks.loadReservation.mockImplementation(() => {
      order.push('pending check');
      return { mark: BigInt(6), pending: [{ id: 'c', nonce: BigInt(6), expiresAt: null }] };
    });
    // The create lands during the check: the nonce it reads is consumed.
    mocks.contractNonce.mockResolvedValue(BigInt(6));
    mocks.query.mockImplementation(async () => { order.push('read'); return ballots(ballotDoc([0, 1])); });

    // The read comes after, so it shows the landed ballot rather than a snapshot from before it.
    expect(await service.getBallotState(open({ multiChoice: true }), VOTER)).toEqual({ choices: [0, 1], pending: false });
    expect(order).toEqual(['settle', 'pending check', 'read']);
  });

  it('reports whether a write to the ballot could still land', async () => {
    const service = await loadService('v7');
    const target = open({ multiChoice: true });
    mocks.query.mockResolvedValue(ballots(ballotDoc([0, 2])));
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [0, 2], pending: false });
    expect(mocks.settle).toHaveBeenCalledWith(VOTER, expect.any(String));

    // A create to this poll's ballot is still out, unconsumed.
    mocks.loadReservation.mockReturnValue({
      mark: BigInt(6),
      pending: [{ id: 'create', nonce: BigInt(6), expiresAt: null, scope: `pollr-vote:${id(9)}` }],
    });
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [0, 2], pending: true });
    // A pending write on another poll does not hold this one.
    expect(await service.getBallotState(open({ id: id(8), multiChoice: true }), VOTER)).toEqual({ choices: [0, 2], pending: false });

    // An unreadable store proves nothing: pending, not settled.
    mocks.loadReservation.mockImplementation(() => { throw new Error('blocked'); });
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [0, 2], pending: true });
  });

  it('throws when the ballot cannot be read', async () => {
    const service = await loadService('v7');
    mocks.query.mockRejectedValue(new Error('down'));
    await expect(service.getBallotState(open(), VOTER)).rejects.toThrow('down');
  });

  it('is never pending on v3', async () => {
    const service = await loadService('v3');
    mocks.query.mockResolvedValue(new Map([['0', { choice: 1 }]]));
    expect(await service.getBallotState(poll(), VOTER)).toEqual({ choices: [1], pending: false });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('is never pending once the poll is past its close', async () => {
    const service = await loadService('v7');
    mocks.loadReservation.mockReturnValue({ mark: BigInt(6), pending: [{ id: 'c', nonce: BigInt(6), expiresAt: null }] });
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    mocks.query.mockResolvedValue(ballots(ballotDoc([0])));

    expect(await service.getBallotState(poll({ endsAt: Date.now() - HOUR }), VOTER)).toEqual({ choices: [0], pending: false });
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});

describe('ballot evidence for the poll delete', () => {
  const known = async () => (await import('./pollr-known-ballots')).pollHasKnownBallots(id(9));

  it('takes a confirmed ballot write as evidence', async () => {
    const service = await loadService('v7');
    expect((await service.setVote(open(), [1], VOTER)).success).toBe(true);
    expect(await known()).toBe(true);
  });

  it('takes a create refused as a duplicate (40105) as evidence, even when the re-read lags', async () => {
    const service = await loadService('v7');
    mocks.createDocument.mockResolvedValue({ success: false, error: 'Document X has duplicate unique properties ["pollId", "$ownerId"] with other documents' });
    // The lagging node shows no ballot before or after.
    mocks.query.mockResolvedValue(new Map());
    expect((await service.setVote(open(), [1], VOTER)).stale).toBe(true);
    expect(await known()).toBe(true);
  });

  it('never takes an unconfirmed create or an optimistic tally as evidence', async () => {
    const service = await loadService('v7');
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });
    expect((await service.setVote(open(), [1], VOTER)).unconfirmed).toBe(true);
    // Folded in locally, then served from the cache: no chain read showed it.
    service.applyOptimisticVotes(id(9), { counts: [0, 0, 0], total: 0, readAt: 1 }, [1]);
    expect((await service.getTally(open())).total).toBe(1);
    expect(mocks.count).not.toHaveBeenCalled();
    expect(await known()).toBe(false);
  });

  it('a ballot the vote service saw makes deletePoll answer voted with no count or write', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([1])));
    await service.getBallotState(open(), VOTER);
    const { pollrPollService } = await import('./pollr-poll-service');
    mocks.count.mockClear();
    expect(await pollrPollService.deletePoll(open({ ownerId: VOTER }), VOTER)).toEqual({ status: 'voted' });
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });

  it('keeps the evidence through a reload or in another tab: nothing resets it', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([1])));
    await service.getBallotState(open(), VOTER);
    expect(await known()).toBe(true);

    // A reload (or another tab): fresh modules, the same browser storage.
    vi.resetModules();
    const reloaded = await loadService('v7');
    expect(await known()).toBe(true);
    // And a lagging zero count cannot offer the delete there either.
    mocks.query.mockResolvedValue(new Map());
    mocks.count.mockResolvedValue(new Map());
    expect(await reloaded.deleteEligible(open({ ownerId: VOTER }), VOTER)).toBe(false);
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('keeps both polls when two tabs record evidence at once, through a reload', async () => {
    // Two tabs: separate module instances over the same browser storage.
    const tabA = await import('./pollr-known-ballots');
    vi.resetModules();
    const tabB = await import('./pollr-known-ballots');
    tabA.markPollHasBallots('poll-p');
    tabB.markPollHasBallots('poll-q');

    vi.resetModules();
    const reloaded = await import('./pollr-known-ballots');
    expect(reloaded.pollHasKnownBallots('poll-p')).toBe(true);
    expect(reloaded.pollHasKnownBallots('poll-q')).toBe(true);
    expect(reloaded.pollHasKnownBallots('poll-r')).toBe(false);
  });

  it('takes an own withdrawn ballot as evidence, though it selects nothing', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc(null, 3)));
    expect(await service.getBallotState(open(), VOTER)).toEqual({ choices: [], pending: false });
    expect(await known()).toBe(true);
  });

  it('takes a tallied selection as evidence', async () => {
    const service = await loadService('v7');
    mocks.count.mockResolvedValue(new Map([['01', 1n]]));
    await service.getTally(open());
    expect(await known()).toBe(true);
  });

  it('holds the delete back while the owner’s ballot state is pending or unreadable', async () => {
    const { ownBallotMayBePending } = await import('./pollr-vote-service');
    expect(ownBallotMayBePending({ status: 'fulfilled', value: { choices: [], pending: false } })).toBe(false);
    expect(ownBallotMayBePending({ status: 'fulfilled', value: { choices: [], pending: true } })).toBe(true);
    // The read may have seen a pending create before failing: a count of 0 must not enable the delete.
    expect(ownBallotMayBePending({ status: 'rejected', reason: new Error('down') })).toBe(true);
  });

  it('a getBallotState whose ballot read fails rejects, and so holds the delete back', async () => {
    const service = await loadService('v7');
    mocks.query.mockRejectedValue(new Error('down'));
    const { ownBallotMayBePending } = await import('./pollr-vote-service');
    const [read] = await Promise.allSettled([service.getBallotState(open(), VOTER)]);
    expect(read.status).toBe('rejected');
    expect(ownBallotMayBePending(read)).toBe(true);
  });

  it('a first create that times out before it is sent leaves the poll deletable on the next load', async () => {
    const service = await loadService('v7');
    const target = open();
    // The identity or nonce read timed out: nothing was signed, reserved or broadcast.
    mocks.createDocument.mockResolvedValue({ success: false, error: 'Request timed out after 8000ms' });
    const result = await service.setVote(target, [1], VOTER);
    const { ownBallotMayBePending } = await import('./pollr-vote-service');
    expect(result.unconfirmed).toBe(true);
    expect(await known()).toBe(false);

    // The next load: no reservation, no ballot, so eligibility is counted again.
    mocks.loadReservation.mockReturnValue(null);
    mocks.query.mockResolvedValue(new Map());
    const [read] = await Promise.allSettled([service.getBallotState(target, VOTER)]);
    expect(read).toMatchObject({ status: 'fulfilled', value: { choices: [], pending: false } });
    expect(ownBallotMayBePending(read)).toBe(false);
  });

  it('offers the delete again after a first vote refused at its preflight read (nothing sent)', async () => {
    const service = await loadService('v7');
    const mine = open({ ownerId: VOTER });
    mocks.query.mockRejectedValueOnce(new Error('down'));
    expect((await service.setVote(mine, [1], VOTER)).success).toBe(false);
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(await known()).toBe(false);

    // The card's check once the submission is over: no reservation, no ballot, and a zero count.
    mocks.query.mockResolvedValue(new Map());
    mocks.count.mockResolvedValue(new Map());
    expect(await service.deleteEligible(mine, VOTER)).toBe(true);
  });

  it('a fresh session keeps a closed poll with an expired replace record undeletable on zero reads', async () => {
    const closed = poll({ ownerId: VOTER, endsAt: Date.now() - 2 * HOUR });
    // Left by an earlier session: a replace on this poll, long past its close.
    const { recordBallotReplace } = await import('./pollr-pending-writes');
    recordBallotReplace(VOTER, { pollId: closed.id, ballotId: 'ballot', revision: 2, endsAt: closed.endsAt as number });
    // A fresh session: nothing in memory, only the stored record.
    vi.resetModules();
    const service = await loadService('v7');
    expect((await import('./pollr-known-ballots')).pollHasKnownBallots(closed.id)).toBe(false);
    mocks.query.mockResolvedValue(new Map());
    mocks.count.mockResolvedValue(new Map());

    expect(await service.deleteEligible(closed, VOTER)).toBe(false);
    const { pollrPollService } = await import('./pollr-poll-service');
    expect(await pollrPollService.deletePoll(closed, VOTER)).toEqual({ status: 'voted' });
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });

  it('offers no delete to anyone but the owner, nor once a ballot is known, a write may land or the state is unreadable', async () => {
    const service = await loadService('v7');
    const mine = open({ ownerId: VOTER });
    mocks.count.mockResolvedValue(new Map());
    expect(await service.deleteEligible(mine, CREATOR)).toBe(false);
    expect(await service.deleteEligible(mine, VOTER, { status: 'fulfilled', value: { choices: [], pending: true } })).toBe(false);
    expect(await service.deleteEligible(mine, VOTER, { status: 'rejected', reason: new Error('down') })).toBe(false);
    expect(mocks.count).not.toHaveBeenCalled();
    // A lagging zero count cannot override a ballot already seen.
    (await import('./pollr-known-ballots')).markPollHasBallots(mine.id);
    expect(await service.deleteEligible(mine, VOTER, { status: 'fulfilled', value: { choices: [], pending: false } })).toBe(false);
    expect(mocks.count).not.toHaveBeenCalled();
  });
});

describe('v7 tallies', () => {
  /** The grouped count's query, the first `documents.count` call. */
  const groupedQuery = () => mocks.count.mock.calls[0][0];

  it('reads every option in one grouped containsAny count over the choices array', async () => {
    const service = await loadService('v7');
    // PV14 keys: the plain byte of each choice. A ballot holding 0 and 2 counts under both.
    mocks.count.mockResolvedValue(new Map([['00', 2n], ['02', 1n]]));

    expect(counted(await service.getTally(open({ multiChoice: true })))).toEqual({ counts: [2, 0, 1], total: 3 });
    expect(groupedQuery()).toEqual({
      dataContractId: expect.any(String),
      documentTypeName: 'vote',
      where: [['pollId', '==', id(9)], ['choices', 'containsAny', [0, 1, 2]]],
      groupBy: ['choices'],
    });
    expect(mocks.count).toHaveBeenCalledTimes(1);
  });

  it('decodes the older top-bit-flipped keys the same way', async () => {
    const service = await loadService('v7');
    mocks.count.mockResolvedValue(new Map([['80', 1n], ['82', 4n]]));
    expect(counted(await service.getTally(open()))).toEqual({ counts: [1, 0, 4], total: 5 });
  });

  it('reads an empty grouped answer as no votes yet', async () => {
    const service = await loadService('v7');
    mocks.count.mockResolvedValue(new Map());
    expect(counted(await service.getTally(open()))).toEqual({ counts: [0, 0, 0], total: 0 });
    expect(mocks.count).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['its keys decode to nothing', () => mocks.count.mockResolvedValueOnce(new Map([['ffff', 3n]]))],
    ['it fails', () => mocks.count.mockRejectedValueOnce(new Error('unsupported operator'))],
  ])('falls back to one contains count per option when the grouped count %s', async (_, arrangeGrouped) => {
    const service = await loadService('v7');
    arrangeGrouped();
    mocks.count.mockImplementation(async ({ where }: { where: unknown[][] }) => new Map([['', BigInt((where[1][2] as number) + 1)]]));

    expect(counted(await service.getTally(open()))).toEqual({ counts: [1, 2, 3], total: 6 });
    expect(mocks.count.mock.calls.slice(1).map((call) => call[0].where)).toEqual([0, 1, 2].map((choice) => [
      ['pollId', '==', id(9)],
      ['choices', 'contains', choice],
    ]));
  });

  it('reports the tally unavailable when every count fails, with no ballot scan', async () => {
    const service = await loadService('v7');
    const { PollTallyUnavailableError } = await import('./pollr-vote-service');
    mocks.count.mockRejectedValue(new Error('down'));
    await expect(service.getTally(open())).rejects.toBeInstanceOf(PollTallyUnavailableError);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('folds a moved vote in as a decrement plus an increment', async () => {
    const service = await loadService('v7');
    const moved = service.applyOptimisticVotes(id(9), { counts: [2, 1, 0], total: 3, readAt: 1 }, [1], [0]);
    expect(moved).toEqual({ counts: [1, 2, 0], total: 3 });
    // The optimistic tally is served from the cache until the next real read.
    expect(await service.getTally(open())).toEqual({ counts: [1, 2, 0], total: 3 });
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('is final only when read off the chain after the close', async () => {
    await loadService('v7');
    const { tallyIsFinal } = await import('./pollr-vote-service');
    const endsAt = Date.now() - 5 * 60_000;
    const closed = poll({ endsAt });

    expect(tallyIsFinal(closed, { counts: [1, 0, 0], total: 1, readAt: Date.now() })).toBe(true);
    // Read while the poll was still open, or optimistic: ballots could still move.
    expect(tallyIsFinal(closed, { counts: [1, 0, 0], total: 1, readAt: endsAt - 1 })).toBe(false);
    expect(tallyIsFinal(closed, { counts: [1, 0, 0], total: 1 })).toBe(false);
    expect(tallyIsFinal(open(), { counts: [1, 0, 0], total: 1, readAt: Date.now() })).toBe(false);
  });

  it('re-reads a tally cached while the poll was open once it has closed', async () => {
    const service = await loadService('v7');
    const endsAt = Date.now() + 10_000;
    mocks.count.mockResolvedValue(new Map([['00', 1n]]));
    expect(counted(await service.getTally(poll({ endsAt })))).toEqual({ counts: [1, 0, 0], total: 1 });

    // A last-second change lands; the poll closes inside the cache TTL.
    vi.advanceTimersByTime(45_000);
    mocks.count.mockResolvedValue(new Map([['01', 1n]]));
    const tally = await service.getTally(poll({ endsAt }));
    expect(counted(tally)).toEqual({ counts: [0, 1, 0], total: 1 });
    expect(mocks.count).toHaveBeenCalledTimes(2);
    // Never the v3 time-bounded scan: v7 enforces the close on chain.
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
  it('v7 reads my one ballot off byPollVoter and returns its choices', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc([2, 0], 2)));

    expect(await service.getMyVotes(poll({ multiChoice: true }), VOTER)).toEqual([0, 2]);
    expect(mocks.query.mock.calls[0][0]).toMatchObject({
      documentTypeName: 'vote',
      where: [['pollId', '==', id(9)], ['$ownerId', '==', VOTER]],
      orderBy: [['pollId', 'asc'], ['$ownerId', 'asc']],
      limit: 1,
    });
  });

  it('v7 reads no choices off a withdrawn ballot or no ballot', async () => {
    const service = await loadService('v7');
    mocks.query.mockResolvedValue(ballots(ballotDoc(null, 3)));
    expect(await service.getMyBallot(poll(), VOTER)).toEqual({ id: 'ballot', revision: 3, choices: [] });
    expect(await service.getMyVotes(poll(), VOTER)).toEqual([]);

    mocks.query.mockResolvedValue(new Map());
    expect(await service.getMyBallot(poll(), VOTER)).toBeNull();
    expect(await service.getMyVotes(poll(), VOTER)).toEqual([]);
  });

  it('throws rather than reporting "no votes" when the read fails', async () => {
    const service = await loadService('v7');
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
