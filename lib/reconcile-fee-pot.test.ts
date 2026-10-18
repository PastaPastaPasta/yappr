import { expect, it, vi } from 'vitest'
import { reconcileFeePot } from './reconcile-fee-pot'

it('does not reconcile a payout with a stale pot or an empty balance without new history', async () => {
  const old = { credits: 100n, lastClaimEpoch: 4, lastClaimantId: null }
  const fresh = { credits: 0n, lastClaimEpoch: 5, lastClaimantId: 'moderator' }
  const read = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce({ ...old, credits: 0n }).mockResolvedValueOnce(fresh)
  const pause = vi.fn(async () => undefined)
  expect(await reconcileFeePot(read, 4, pause)).toEqual(fresh)
  expect(pause).toHaveBeenCalledTimes(2)
})
it('bounds retries and leaves a confirmed claim pending when history is still stale', async () => {
  const read = vi.fn(async () => ({ credits: 99n, lastClaimEpoch: null, lastClaimantId: null }))
  expect(await reconcileFeePot(read, null, async () => undefined)).toBeNull()
  expect(read).toHaveBeenCalledTimes(4)
})
it('recovers from a failed read and accepts a claim after Never claimed', async () => {
  const fresh = { credits: 5n, lastClaimEpoch: 115, lastClaimantId: 'moderator' }
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(fresh)
  expect(await reconcileFeePot(read, null, async () => undefined)).toEqual(fresh)
})
