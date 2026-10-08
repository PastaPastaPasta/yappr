import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NonceReservation, PendingTransition } from './identity-nonce';

// Whether an earlier write could still change a voter's ballots on one poll,
// against the real reservation rules (`stillPending`) with the store and the
// chain nonce mocked.
const mocks = vi.hoisted(() => ({ loadReservation: vi.fn(), contractNonce: vi.fn(), getDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({ identities: { contractNonce: mocks.contractNonce }, documents: { get: mocks.getDocument } }),
}));
// The uncertain-replace record lives in localStorage; an in-memory one here.
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});

vi.mock('./identity-nonce', async (load) => ({
  ...(await load<typeof import('./identity-nonce')>()),
  loadReservation: mocks.loadReservation,
}));

const OWNER = '11111111111111111111111111111111';
const POLL = 'poll-a';
const OTHER_POLL = 'poll-b';
const MINUTE = 60_000;

/** A store holding one create reserved at `nonce`, for `scope`. */
const createPending = (nonce: bigint, scope?: string): NonceReservation => {
  const entry: PendingTransition = { id: 'c', nonce, expiresAt: null };
  return { mark: nonce, pending: [scope === undefined ? entry : { ...entry, scope }] };
};

beforeEach(() => {
  vi.resetAllMocks();
  storage.clear();
  mocks.loadReservation.mockReturnValue(null);
  mocks.contractNonce.mockResolvedValue(BigInt(4));
});

/** A replace of ballot `b0` on POLL writing revision 3, closing in an hour. */
const replaceRecord = (overrides: Record<string, unknown> = {}) => ({
  pollId: POLL, ballotId: 'b0', revision: 3, endsAt: Date.now() + 60 * MINUTE, ...overrides,
});

describe('uncertain ballot replaces', () => {
  it('record the replaced ballot as evidence for the v6 delete, even once the replace settles', async () => {
    const { pollrWriteMayStillExecute, recordBallotReplace } = await import('./pollr-pending-writes');
    const { pollHasKnownBallots } = await import('./pollr-known-ballots');
    // A fresh session: the persisted record of a replace that has since landed.
    recordBallotReplace(OWNER, replaceRecord({ pollId: 'poll-settled' }));
    mocks.getDocument.mockResolvedValue({ $revision: 3 });

    expect(await pollrWriteMayStillExecute(OWNER, 'poll-settled')).toBe(false);
    // The record is gone, but the ballot it replaced exists for good.
    expect(pollHasKnownBallots('poll-settled')).toBe(true);
    expect(pollHasKnownBallots('poll-never-voted')).toBe(false);
  });

  it('keep a replace pending past its reservation’s lifetime until the ballot reaches its revision', async () => {
    const { pollrWriteMayStillExecute, recordBallotReplace } = await import('./pollr-pending-writes');
    recordBallotReplace(OWNER, replaceRecord());
    // The nonce store has long forgotten it (no reservation at all), and the ballot is still at 2.
    mocks.getDocument.mockResolvedValue({ $revision: 2 });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30 * MINUTE);
    try {
      expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(true);
      // Another poll is unaffected.
      expect(await pollrWriteMayStillExecute(OWNER, OTHER_POLL)).toBe(false);
      // The ballot at revision 3: the replace (built on 2) can never execute now.
      mocks.getDocument.mockResolvedValue({ $revision: 3 });
      expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(false);
      // Proven once, the record is gone: no further read.
      mocks.getDocument.mockClear();
      expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(false);
      expect(mocks.getDocument).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('count while the ballot cannot be read, and stop once the poll has closed', async () => {
    const { pollrWriteMayStillExecute, recordBallotReplace } = await import('./pollr-pending-writes');
    recordBallotReplace(OWNER, replaceRecord({ endsAt: Date.now() + MINUTE }));
    mocks.getDocument.mockRejectedValue(new Error('down'));
    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(true);
    // Past the close (and its margin) no ballot write can land.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    try {
      expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('are cleared by a verdict', async () => {
    const { pollrWriteMayStillExecute, recordBallotReplace, settleBallotReplace } = await import('./pollr-pending-writes');
    recordBallotReplace(OWNER, replaceRecord());
    settleBallotReplace(OWNER, replaceRecord());
    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(false);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });
});

describe('pollrWriteMayStillExecute', () => {
  it('is false with nothing pending, without reading the chain', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(false);
    expect(mocks.contractNonce).not.toHaveBeenCalled();
  });

  it('counts an unconfirmed create until Platform shows its nonce consumed', async () => {
    const { pollrBallotScope, pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    mocks.loadReservation.mockReturnValue(createPending(BigInt(5), pollrBallotScope(POLL)));

    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(true);
    // Consumed — by the create landing or by another transition: it cannot execute now.
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(false);
  });

  it('counts only writes to this poll’s ballots, and unscoped writes everywhere', async () => {
    const { pollrBallotScope, pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    // A ballot write on another poll holds nothing back here, and never reads the chain.
    mocks.loadReservation.mockReturnValue(createPending(BigInt(5), pollrBallotScope(OTHER_POLL)));
    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(false);
    expect(mocks.contractNonce).not.toHaveBeenCalled();
    // One that names no target (a poll create, or stored before scopes) may touch any poll.
    mocks.loadReservation.mockReturnValue(createPending(BigInt(5)));
    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(true);
  });

  it('keeps an old, unconsumed create pending: a signed transition has no deadline', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    mocks.loadReservation.mockReturnValue(createPending(BigInt(5)));
    // An hour on (a chain pause, a clock correction): its nonce is still unconsumed.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * MINUTE);
    try {
      expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // Out of the window 24 behind the tip, it can never execute.
    mocks.contractNonce.mockResolvedValue(BigInt(30));
    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(false);
  });

  it('counts a pending write when the chain nonce cannot be read', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    mocks.loadReservation.mockReturnValue(createPending(BigInt(5)));
    mocks.contractNonce.mockRejectedValue(new Error('down'));
    expect(await pollrWriteMayStillExecute(OWNER, POLL)).toBe(true);
  });

  it('fails closed when the reservation store cannot be read', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    mocks.loadReservation.mockImplementation(() => { throw new Error('blocked'); });
    await expect(pollrWriteMayStillExecute(OWNER, POLL)).rejects.toThrow('blocked');
  });
});
