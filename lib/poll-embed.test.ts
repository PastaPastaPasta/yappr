import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const APP_CONTRACT = 'GBCR8JqtXNMZa4B16ZAYm3RkNHrPcU3D36jcAoYWvr8E'
const DEVNET_CONTRACT = 'BX94nj87AZ61KpU2Vqv4oPUu5N4b4YrKrvHvfB833Q3z'

async function load(topology: string, contractId: string) {
  vi.stubEnv('NEXT_PUBLIC_POLLR_TOPOLOGY', topology)
  vi.stubEnv('NEXT_PUBLIC_POLLR_CONTRACT_ID', contractId)
  return (await import('./poll-embed')).pollMissingMeansDeleted
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllEnvs())

describe('pollMissingMeansDeleted', () => {
  it('reads a missing native poll on v6 as deleted', async () => {
    const missingMeansDeleted = await load('v6', DEVNET_CONTRACT)
    expect(missingMeansDeleted(true)).toBe(true)
    // A legacy link names a poll in the standalone app's contract, which a
    // devnet clone cannot see: not deleted, just unavailable here.
    expect(missingMeansDeleted(false)).toBe(false)
  })

  it('trusts a legacy link when the app reads this same contract', async () => {
    const missingMeansDeleted = await load('v6', APP_CONTRACT)
    expect(missingMeansDeleted(false)).toBe(true)
  })

  it('never says deleted before v6, where polls are permanent', async () => {
    const missingMeansDeleted = await load('v5', DEVNET_CONTRACT)
    expect(missingMeansDeleted(true)).toBe(false)
  })
})
