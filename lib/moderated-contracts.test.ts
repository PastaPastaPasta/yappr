/**
 * Which registered cuts of the storefront and blog contracts the app moderates:
 * the elected declaration the committed files describe arrived with
 * storefront v6 (the mainnet re-cut; v7 only re-encodes variants) and blog v7.
 * Below those, and with no contract id, the contract is not moderated here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

async function contractsUnder(env: Record<string, string>) {
  vi.resetModules()
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return import('./moderated-contracts')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('storefront moderation by topology', () => {
  const ID = 'Sto1111111111111111111111111111111111111111'

  it.each([
    ['v5', false],
    ['v6', true],
    ['v7', true],
    ['v9', true],
  ] as const)('storefront %s: moderated = %s', async (topology, moderated) => {
    const { moderatedContract } = await contractsUnder({ NEXT_PUBLIC_STOREFRONT_TOPOLOGY: topology, NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: ID })
    const storefront = moderatedContract('storefront')
    expect(storefront.moderated()).toBe(moderated)
    expect(storefront.elected() !== null).toBe(moderated)
    expect(storefront.deletableTypes().length > 0).toBe(moderated)
  })

  it('is off without a contract id, whatever the topology', async () => {
    const { moderatedContract } = await contractsUnder({ NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v9', NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: '' })
    expect(moderatedContract('storefront').moderated()).toBe(false)
    expect(moderatedContract('storefront').elected()).toBeNull()
  })
})

describe('blog moderation by topology', () => {
  const ID = 'Blg1111111111111111111111111111111111111111'

  it.each([
    ['v6', false],
    ['v7', true],
    ['v8', true],
  ] as const)('blog %s: moderated = %s', async (topology, moderated) => {
    const { moderatedContract } = await contractsUnder({ NEXT_PUBLIC_BLOG_TOPOLOGY: topology, NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID: ID })
    expect(moderatedContract('blog').moderated()).toBe(moderated)
    expect(moderatedContract('blog').listsKept().length > 0).toBe(moderated)
  })
})

describe('documentNoun', () => {
  it('names storefront and blog types as people say them', async () => {
    const { documentNoun } = await contractsUnder({})
    expect(documentNoun('storeItem')).toBe('listing')
    expect(documentNoun('itemReview')).toBe('review')
    expect(documentNoun('blogComment')).toBe('comment')
    expect(documentNoun('post')).toBe('post')
  })
})
