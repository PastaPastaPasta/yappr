import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NonceReservation } from './identity-nonce';

// Whether an earlier Pollr write could still execute, against the real
// reservation rules (`stillPending`) with the store and the chain nonce mocked.
const mocks = vi.hoisted(() => ({ loadReservation: vi.fn(), contractNonce: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ identities: { contractNonce: mocks.contractNonce } }) }));
vi.mock('./identity-nonce', async (load) => ({
  ...(await load<typeof import('./identity-nonce')>()),
  loadReservation: mocks.loadReservation,
}));

const OWNER = '11111111111111111111111111111111';
const MINUTE = 60_000;

/** A store holding one create reserved at `nonce`, `ageMs` ago. */
const createPending = (nonce: bigint, ageMs = 0): NonceReservation => ({
  mark: nonce,
  pending: [{ id: 'c', nonce, expiresAt: null, reservedAt: Date.now() - ageMs }],
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadReservation.mockReturnValue(null);
});

describe('pollrWriteMayStillExecute', () => {
  it('is false with nothing pending, without reading the chain', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    expect(await pollrWriteMayStillExecute(OWNER)).toBe(false);
    expect(mocks.contractNonce).not.toHaveBeenCalled();
  });

  it('counts an unconfirmed create until Platform shows its nonce consumed', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    mocks.loadReservation.mockReturnValue(createPending(BigInt(5)));

    mocks.contractNonce.mockResolvedValue(BigInt(4));
    expect(await pollrWriteMayStillExecute(OWNER)).toBe(true);
    // Consumed — by the create landing or by another transition: it cannot execute now.
    mocks.contractNonce.mockResolvedValue(BigInt(5));
    expect(await pollrWriteMayStillExecute(OWNER)).toBe(false);
  });

  it('stops counting a create old enough to have been dropped', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    mocks.contractNonce.mockResolvedValue(BigInt(4));
    mocks.loadReservation.mockReturnValue(createPending(BigInt(5), 16 * MINUTE));
    expect(await pollrWriteMayStillExecute(OWNER)).toBe(false);
  });

  it('counts a pending write when the chain nonce cannot be read', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    mocks.loadReservation.mockReturnValue(createPending(BigInt(5)));
    mocks.contractNonce.mockRejectedValue(new Error('down'));
    expect(await pollrWriteMayStillExecute(OWNER)).toBe(true);
  });

  it('fails closed when the reservation store cannot be read', async () => {
    const { pollrWriteMayStillExecute } = await import('./pollr-pending-writes');
    mocks.loadReservation.mockImplementation(() => { throw new Error('blocked'); });
    await expect(pollrWriteMayStillExecute(OWNER)).rejects.toThrow('blocked');
  });
});
