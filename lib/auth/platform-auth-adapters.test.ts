import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'

// The login-time profile check the platform-auth controller runs: `false`
// sends the user to /profile/create, so it must only mean "no profile".
const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/services/evo-sdk-service', () => {
  const sdk = { documents: { query } }
  return {
    evoSdkService: { initialize: async () => undefined, getSdk: async () => sdk },
    getEvoSdk: async () => sdk,
  }
})

const identityId = '11111111111111111111111111111111'

async function hasProfile(): Promise<boolean> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
  const { createYapprPlatformAuthDependencies } = await import('./platform-auth-adapters')
  const profiles = createYapprPlatformAuthDependencies().profiles
  if (!profiles) throw new Error('no profile adapter')
  return profiles.hasProfile(identityId)
}

beforeEach(() => {
  query.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('v10 login profile check', () => {
  it('requires a profile when the queries succeed and find no yapprProfile', async () => {
    query.mockResolvedValue([])
    expect(await hasProfile()).toBe(false)
  })

  it('fails open when the yapprProfile query fails', async () => {
    query.mockImplementation(async ({ dataContractId }: { dataContractId: string }) => {
      if (dataContractId === YAPPR_CONTRACT_ID) throw new Error('DAPI timeout')
      return []
    })
    expect(await hasProfile()).toBe(true)
  })
})
