import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NonceReservation, PendingTransition } from './identity-nonce';

// Whether an earlier write could still change a voter's ballots on one poll,
// against the real reservation rules (`stillPending`) with the store and the
// chain nonce mocked.
const mocks = vi.hoisted(() => ({ loadReservation: vi.fn(), contractNonce: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ identities: { contractNonce: mocks.contractNonce } }) }));
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
  mocks.loadReservation.mockReturnValue(null);
  mocks.contractNonce.mockResolvedValue(BigInt(4));
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
