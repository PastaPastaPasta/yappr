import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { Poll } from './pollr-poll-service';

// Exercises the v3/v4/v5 branch points of the ballot service at an in-memory
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
  settleSupersededReplaces: mocks.settle,
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
  optionCount: 3,
  multiChoice: false,
  ...overrides,
});

async function loadService(topology: 'v3' | 'v4' | 'v5' | 'v6') {
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
  mocks.settle.mockResolvedValue(0);
  mocks.loadReservation.mockReturnValue(null);
  storage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('v5 ballots', () => {
  const open = (overrides: Partial<Poll> = {}) => poll({ endsAt: Date.now() + HOUR, ...overrides });

  // v6 keeps v5's ballots unchanged.
  it.each(['v5', 'v6'] as const)('%s creates a first single-choice ballot on slot 0, copying the poll’s bound fields', async (topology) => {
    const service = await loadService(topology);
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

  it('v6 stops a multi-choice vote at the first 40120 (the poll was deleted) and keeps the error', async () => {
    const service = await loadService('v6');
    const error = 'Referenced document poll X not found for vote.pollId (code=40120)';
    mocks.createDocument.mockResolvedValue({ success: false, error });

    const result = await service.setVote(open({ multiChoice: true }), [0, 1, 2], VOTER);
    // Every planned ballot names the same missing poll: one paid refusal, not three.
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, closed: false, stale: false, error });
  });

  it('v6 reports the 40120 even after an earlier, different failure in the same vote', async () => {
    const service = await loadService('v6');
    const missing = 'Referenced document poll X not found for vote.pollId (code=40120)';
    mocks.createDocument
      .mockResolvedValueOnce({ success: false, error: 'Identity not found' })
      .mockResolvedValueOnce({ success: false, error: missing });

    const result = await service.setVote(open({ multiChoice: true }), [0, 1, 2], VOTER);
    // Stopped at the 40120, and the card sees it to re-read the poll.
    expect(mocks.createDocument).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: false, error: missing });
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

  it('settles a timed-out replace that landed before the next edit writes', async () => {
    const service = await loadService('v5');
    const order: string[] = [];
    mocks.settle.mockImplementation(async () => { order.push('settle'); return 0; });
    mocks.query.mockImplementation(async () => { order.push('read'); return ballots(ballotDoc(0, 1)); });
    mocks.updateDocument.mockImplementation(async () => {
      order.push('replace');
      return { success: false, error: 'wait for state transition result timed out' };
    });

    // The first edit times out: it reports unconfirmed and leaves the reservation.
    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ unconfirmed: true });

    // It landed. The next edit releases that reservation first, then plans
    // against the ballot at its new revision and writes.
    mocks.settle.mockImplementation(async () => { order.push('settle'); return 1; });
    // The chain shows the ballot at the revision the replace wrote, so its record clears too.
    mocks.getDocument.mockResolvedValue({ $revision: 2 });
    mocks.query.mockImplementation(async () => { order.push('read'); return ballots(ballotDoc(0, 2, 2)); });
    mocks.updateDocument.mockImplementation(async () => { order.push('replace'); return { success: true }; });
    expect(await service.setVote(open(), [0], VOTER)).toEqual({ success: true, choices: [0], closed: false, stale: false });

    expect(order).toEqual(['settle', 'read', 'replace', 'settle', 'read', 'replace']);
    expect(mocks.settle).toHaveBeenCalledWith(VOTER, expect.any(String));
    expect(mocks.updateDocument.mock.calls[1][5]).toBe(2);
  });

  it('still votes when settling pending replaces fails', async () => {
    const service = await loadService('v5');
    mocks.settle.mockRejectedValue(new Error('down'));

    expect((await service.setVote(open(), [1], VOTER)).success).toBe(true);
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
  });

  it('holds back a reduced selection while the unconfirmed half of a first vote could still land', async () => {
    const service = await loadService('v5');
    const target = open({ multiChoice: true });
    // First vote [0, 1]: slot 0 confirms, slot 1's create goes unconfirmed.
    mocks.createDocument
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true, confirmed: false });
    expect(await service.setVote(target, [0, 1], VOTER)).toMatchObject({ unconfirmed: true });

    // That create is still reserved at its nonce (6) and Platform has not consumed it.
    mocks.loadReservation.mockReturnValue({
      mark: BigInt(6),
      pending: [{ id: 'slot-1-create', nonce: BigInt(6), expiresAt: null, scope: `pollr-vote:${id(9)}` }],
    });
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    // The chain shows only slot 0, so [0] plans no writes, yet slot 1 can still land.
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0)));
    mocks.createDocument.mockClear();

    expect(await service.setVote(target, [0], VOTER)).toMatchObject({ success: false, heldBack: true });
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(mocks.updateDocument).not.toHaveBeenCalled();

    // Once its nonce is consumed (it landed or never will), the same selection goes through.
    mocks.contractNonce.mockResolvedValue(BigInt(6));
    expect(await service.setVote(target, [0], VOTER)).toEqual({ success: true, choices: [0], closed: false, stale: false });
  });

  it('still holds back a zero-write selection behind an aged, unconsumed create', async () => {
    const service = await loadService('v5');
    mocks.loadReservation.mockReturnValue({
      mark: BigInt(6),
      pending: [{ id: 'slot-1-create', nonce: BigInt(6), expiresAt: null, scope: `pollr-vote:${id(9)}` }],
    });
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0)));
    // An hour later its nonce is still unconsumed, so it can still land.
    vi.setSystemTime(Date.now() + HOUR);

    expect(await service.setVote(open({ multiChoice: true }), [0], VOTER)).toMatchObject({ success: false, heldBack: true });
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(mocks.updateDocument).not.toHaveBeenCalled();
  });

  it('getBallotState reads the ballots only after the settle and the pending check', async () => {
    const service = await loadService('v5');
    const order: string[] = [];
    mocks.settle.mockImplementation(async () => { order.push('settle'); return 0; });
    mocks.loadReservation.mockImplementation(() => {
      order.push('pending check');
      return { mark: BigInt(6), pending: [{ id: 'c', nonce: BigInt(6), expiresAt: null }] };
    });
    // The create lands during the check: the nonce it reads is consumed.
    mocks.contractNonce.mockResolvedValue(BigInt(6));
    mocks.query.mockImplementation(async () => { order.push('read'); return ballots(ballotDoc(0, 0), ballotDoc(1, 1)); });

    // The read comes after, so it shows the landed slot 1 rather than a snapshot from before it.
    expect(await service.getBallotState(open({ multiChoice: true }), VOTER)).toEqual({ choices: [0, 1], pending: false });
    expect(order).toEqual(['settle', 'pending check', 'read']);
  });

  it('refuses a reduced selection that plans no writes when the reservation store is unreadable', async () => {
    const service = await loadService('v5');
    const { NONCE_STORE_ERROR } = await import('@/lib/error-utils');
    // Slot 1's create may still be out there, but nothing can say so.
    mocks.loadReservation.mockImplementation(() => { throw new Error(NONCE_STORE_ERROR); });
    // The chain shows only slot 0, so [0] would plan no writes and never reach a write path.
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0)));

    expect(await service.setVote(open({ multiChoice: true }), [0], VOTER)).toEqual({
      success: false, closed: false, stale: false, error: NONCE_STORE_ERROR,
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('getBallotState reads the ballots and whether a write to them could still land', async () => {
    const service = await loadService('v5');
    const target = open({ multiChoice: true });
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0), ballotDoc(1, null)));
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [0], pending: false });
    expect(mocks.settle).toHaveBeenCalledWith(VOTER, expect.any(String));

    // A create to this poll's ballots is still out, unconsumed.
    mocks.loadReservation.mockReturnValue({
      mark: BigInt(6),
      pending: [{ id: 'slot-1-create', nonce: BigInt(6), expiresAt: null, scope: `pollr-vote:${id(9)}` }],
    });
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [0], pending: true });
    // A pending write on another poll does not hold this one.
    expect(await service.getBallotState(open({ id: id(8), multiChoice: true }), VOTER)).toEqual({ choices: [0], pending: false });

    // An unreadable store proves nothing: pending, not settled.
    mocks.loadReservation.mockImplementation(() => { throw new Error('blocked'); });
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [0], pending: true });
  });

  it('getBallotState throws when the ballots cannot be read', async () => {
    const service = await loadService('v5');
    mocks.query.mockRejectedValue(new Error('down'));
    await expect(service.getBallotState(open(), VOTER)).rejects.toThrow('down');
  });

  it('getBallotState is never pending before v5', async () => {
    const service = await loadService('v3');
    mocks.query.mockResolvedValue(new Map([['0', { choice: 1 }]]));
    expect(await service.getBallotState(poll(), VOTER)).toEqual({ choices: [1], pending: false });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('reserves each ballot write with its poll’s scope', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0, 3)));
    await service.setVote(open({ multiChoice: true }), [1], VOTER);

    const scope = `pollr-vote:${id(9)}`;
    expect(mocks.updateDocument.mock.calls[0][6]).toBe(scope);
    expect(mocks.createDocument.mock.calls[0][4]).toEqual({ reservationScope: scope });
  });

  it('reports a replace refused without a verdict as pending, not as settled', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1, 2)));
    // A transport failure: withSdkSignedWrite keeps its reservation pending.
    mocks.updateDocument.mockImplementation(async () => {
      mocks.loadReservation.mockReturnValue({ mark: BigInt(0), pending: [{ id: 'r', nonce: null, expiresAt: Date.now() + HOUR, scope: `pollr-vote:${id(9)}` }] });
      return { success: false, error: 'fetch failed' };
    });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, unconfirmed: true, error: 'fetch failed' });
  });

  it('holds back a vote whose first write waits on another poll’s pending write', async () => {
    const service = await loadService('v5');
    const { PENDING_WRITE_ERROR } = await import('@/lib/error-utils');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1, 2)));
    mocks.updateDocument.mockResolvedValue({ success: false, error: PENDING_WRITE_ERROR });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, heldBack: true });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('getBallotState is never pending once the poll is past its close', async () => {
    const service = await loadService('v5');
    mocks.loadReservation.mockReturnValue({ mark: BigInt(6), pending: [{ id: 'c', nonce: BigInt(6), expiresAt: null }] });
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0)));

    expect(await service.getBallotState(poll({ endsAt: Date.now() - HOUR }), VOTER)).toEqual({ choices: [0], pending: false });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('holds a zero-write selection behind an aged, unconfirmed replace until its revision is proven', async () => {
    const service = await loadService('v5');
    const target = open();
    // 0 -> 1 goes out as a replace (writing revision 3) and times out.
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0, 2)));
    mocks.updateDocument.mockResolvedValue({ success: false, error: 'wait for state transition result timed out' });
    expect(await service.setVote(target, [1], VOTER)).toMatchObject({ unconfirmed: true });

    // 30 minutes on, the nonce store no longer holds it, and the ballot still reads choice 0 at revision 2.
    vi.setSystemTime(Date.now() + 30 * 60_000);
    mocks.getDocument.mockResolvedValue({ $revision: 2 });
    mocks.updateDocument.mockClear();
    expect(await service.setVote(target, [0], VOTER)).toMatchObject({ success: false, heldBack: true });
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [0], pending: true });
    expect(mocks.updateDocument).not.toHaveBeenCalled();

    // The ballot reaches revision 3 (the replace landed): settled, and it reads choice 1.
    mocks.getDocument.mockResolvedValue({ $revision: 3 });
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1, 3)));
    expect(await service.getBallotState(target, VOTER)).toEqual({ choices: [1], pending: false });
  });

  it('clears the replace record on a confirmed replace and on a consensus refusal', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 0, 2)));
    expect((await service.setVote(open(), [1], VOTER)).success).toBe(true);
    expect(await service.getBallotState(open(), VOTER)).toMatchObject({ pending: false });

    mocks.updateDocument.mockResolvedValue({ success: false, error: 'Document X has invalid revision Some(2) (code=40106)' });
    await service.setVote(open(), [1], VOTER);
    expect(await service.getBallotState(open(), VOTER)).toMatchObject({ pending: false });
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed create as unconfirmed, not as counted', async () => {
    const service = await loadService('v5');
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });

    expect(await service.setVote(open({ multiChoice: true }), [0, 1], VOTER)).toMatchObject({ success: false, unconfirmed: true });
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
  });

  it('stops at a later write held back for a pending transition, then re-reads', async () => {
    const service = await loadService('v5');
    const { PENDING_WRITE_ERROR } = await import('@/lib/error-utils');
    mocks.createDocument
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValue({ success: false, error: PENDING_WRITE_ERROR });
    mocks.query.mockResolvedValueOnce(new Map()).mockResolvedValue(ballots(ballotDoc(0, 0)));

    expect(await service.setVote(open({ multiChoice: true }), [0, 1, 2], VOTER)).toMatchObject({ success: false, choices: [0] });
    expect(mocks.createDocument).toHaveBeenCalledTimes(2);
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
    // A consensus refusal: a verdict, so nothing is left in flight.
    const refusal = 'Identity has insufficient balance (code=40001)';
    mocks.updateDocument.mockResolvedValue({ success: false, error: refusal });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, choices: null, error: refusal });
  });

  it('treats a replace refused without a verdict as possibly in flight', async () => {
    const service = await loadService('v5');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1)));
    mocks.getDocument.mockResolvedValue({ $revision: 1 });
    mocks.updateDocument.mockResolvedValue({ success: false, error: 'insufficient balance' });

    expect(await service.setVote(open(), [2], VOTER)).toMatchObject({ success: false, unconfirmed: true });
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

describe('ballot evidence for the v6 delete', () => {
  const known = async () => (await import('./pollr-known-ballots')).pollHasKnownBallots(id(9));
  const openPoll = (overrides: Partial<Poll> = {}) => poll({ endsAt: Date.now() + HOUR, ...overrides });

  it('keeps a confirmed first ballot as evidence when a later write of the same vote times out', async () => {
    const service = await loadService('v6');
    mocks.createDocument
      .mockResolvedValueOnce({ success: true, confirmed: true })
      .mockResolvedValueOnce({ success: false, error: 'Request timed out after 8000ms' });

    const result = await service.setVote(openPoll({ multiChoice: true }), [0, 1], VOTER);
    expect(result.unconfirmed).toBe(true);
    // The first create landed: the poll is permanent, whatever a lagging count says later.
    expect(await known()).toBe(true);
  });

  it('takes a create refused as a duplicate (40105) as evidence, even when the re-read lags', async () => {
    const service = await loadService('v6');
    mocks.createDocument.mockResolvedValue({ success: false, error: 'Document X has duplicate unique properties ["pollId", "$ownerId", "slot"] with other documents' });
    // The lagging node shows no ballot before or after.
    mocks.query.mockResolvedValue(new Map());
    expect((await service.setVote(openPoll(), [1], VOTER)).stale).toBe(true);
    expect(await known()).toBe(true);
  });

  it('never takes an unconfirmed create or an optimistic tally as evidence', async () => {
    const service = await loadService('v6');
    mocks.createDocument.mockResolvedValue({ success: true, confirmed: false });
    expect((await service.setVote(openPoll(), [1], VOTER)).unconfirmed).toBe(true);
    // Folded in locally, then served from the cache: no chain read showed it.
    service.applyOptimisticVotes(id(9), { counts: [0, 0, 0], total: 0, readAt: 1 }, [1]);
    expect((await service.getTally(openPoll())).total).toBe(1);
    expect(mocks.count).not.toHaveBeenCalled();
    expect(await known()).toBe(false);
  });

  it('a ballot the vote service saw makes deletePoll answer voted with no count or write', async () => {
    const service = await loadService('v6');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, 1)));
    await service.getBallotState(openPoll(), VOTER);
    const { pollrPollService } = await import('./pollr-poll-service');
    mocks.count.mockClear();
    expect(await pollrPollService.deletePoll(openPoll({ ownerId: VOTER }), VOTER)).toEqual({ status: 'voted' });
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });

  it('takes an own withdrawn ballot as evidence, though it selects nothing', async () => {
    const service = await loadService('v6');
    mocks.query.mockResolvedValue(ballots(ballotDoc(0, null, 3)));
    expect(await service.getBallotState(openPoll(), VOTER)).toEqual({ choices: [], pending: false });
    expect(await known()).toBe(true);
  });

  it('takes a tallied selection as evidence', async () => {
    const service = await loadService('v6');
    mocks.count.mockResolvedValue(new Map([['81', 1n]]));
    await service.getTally(openPoll());
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
    const service = await loadService('v6');
    mocks.query.mockRejectedValue(new Error('down'));
    const { ownBallotMayBePending } = await import('./pollr-vote-service');
    const [read] = await Promise.allSettled([service.getBallotState(poll({ endsAt: Date.now() + HOUR }), VOTER)]);
    expect(read.status).toBe('rejected');
    expect(ownBallotMayBePending(read)).toBe(true);
  });

  it('a first create that times out before it is sent leaves the poll deletable on the next load', async () => {
    const service = await loadService('v6');
    const open = poll({ endsAt: Date.now() + HOUR });
    // The identity or nonce read timed out: nothing was signed, reserved or broadcast.
    mocks.createDocument.mockResolvedValue({ success: false, error: 'Request timed out after 8000ms' });
    const result = await service.setVote(open, [1], VOTER);
    const { ownBallotMayBePending } = await import('./pollr-vote-service');
    expect(result.unconfirmed).toBe(true);
    expect(await known()).toBe(false);

    // The next load: no reservation, no ballot, so eligibility is counted again.
    mocks.loadReservation.mockReturnValue(null);
    mocks.query.mockResolvedValue(new Map());
    const [read] = await Promise.allSettled([service.getBallotState(open, VOTER)]);
    expect(read).toMatchObject({ status: 'fulfilled', value: { choices: [], pending: false } });
    expect(ownBallotMayBePending(read)).toBe(false);
  });

  it('offers the delete again after a first vote refused at its preflight read (nothing sent)', async () => {
    const service = await loadService('v6');
    const mine = openPoll({ ownerId: VOTER });
    mocks.query.mockRejectedValueOnce(new Error('down'));
    expect((await service.setVote(mine, [1], VOTER)).success).toBe(false);
    expect(mocks.createDocument).not.toHaveBeenCalled();

    // The card's check once the submission is over (Cancel changes nothing):
    // no reservation, no ballot, and a zero count.
    mocks.query.mockResolvedValue(new Map());
    mocks.count.mockResolvedValue(new Map());
    expect(await service.deleteEligible(mine, VOTER)).toBe(true);
  });

  it('a fresh session keeps a closed poll with an expired replace record undeletable on zero reads', async () => {
    const closed = poll({ ownerId: VOTER, endsAt: Date.now() - 2 * HOUR });
    // Left by an earlier session: a replace on this poll, long past its close.
    const { recordBallotReplace } = await import('./pollr-pending-writes');
    recordBallotReplace(VOTER, { pollId: closed.id, ballotId: 'ballot-0', revision: 2, endsAt: closed.endsAt as number });
    // A fresh session: nothing in memory, only the stored record.
    vi.resetModules();
    const service = await loadService('v6');
    expect((await import('./pollr-known-ballots')).pollHasKnownBallots(closed.id)).toBe(false);
    mocks.query.mockResolvedValue(new Map());
    mocks.count.mockResolvedValue(new Map());

    expect(await service.deleteEligible(closed, VOTER)).toBe(false);
    const { pollrPollService } = await import('./pollr-poll-service');
    expect(await pollrPollService.deletePoll(closed, VOTER)).toEqual({ status: 'voted' });
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });

  it('offers no delete to anyone but the owner, nor once a ballot is known, a write may land or the state is unreadable', async () => {
    const service = await loadService('v6');
    const mine = openPoll({ ownerId: VOTER });
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

  it('a vote refused at its preflight read leaves the poll deletable on a later zero count', async () => {
    const service = await loadService('v6');
    mocks.query.mockRejectedValue(new Error('down'));
    const result = await service.setVote(poll({ endsAt: Date.now() + HOUR }), [1], VOTER);
    expect(result.success).toBe(false);
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(await known()).toBe(false);
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
