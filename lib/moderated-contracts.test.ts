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
    ['v10', true],
  ] as const)('storefront %s: moderated = %s', async (topology, moderated) => {
    const { moderatedContract } = await contractsUnder({ NEXT_PUBLIC_STOREFRONT_TOPOLOGY: topology, NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: ID })
    const storefront = moderatedContract('storefront')
    expect(storefront.moderated()).toBe(moderated)
    expect(storefront.elected() !== null).toBe(moderated)
    expect(storefront.deletableTypes().length > 0).toBe(moderated)
  })

  it('takes reports from v10 on: below it the registered cut has no report type, whatever the file declares', async () => {
    const v9 = (await contractsUnder({ NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v9', NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: ID })).moderatedContract('storefront')
    expect(v9.deletableTypes()).not.toContain('report')
    expect(v9.elected()?.moderatedDocumentTypes.report).toBeUndefined()
    expect([v9.reportsResolved(), v9.reportTargets()]).toEqual([false, []])
    const v10 = (await contractsUnder({ NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v10', NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: ID })).moderatedContract('storefront')
    expect(v10.deletableTypes()).toContain('report')
    expect(v10.elected()?.moderatedDocumentTypes.report).toEqual(['deleteDocuments', 'changeDocumentFields'])
    expect([v10.reportsResolved(), v10.keepsRecord('report')]).toEqual([true, false])
    expect(v10.reportTargets()).toEqual([
      { field: 'storeId', docType: 'store' }, { field: 'itemId', docType: 'storeItem' },
      { field: 'storeReviewId', docType: 'storeReview' }, { field: 'itemReviewId', docType: 'itemReview' },
    ])
    // The answers are stable objects (React effects depend on them).
    expect(v10.deletableTypes()).toBe(v10.deletableTypes())
    expect(v10.elected()).toBe(v10.elected())
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
    ['v9', true],
  ] as const)('blog %s: moderated = %s', async (topology, moderated) => {
    const { moderatedContract } = await contractsUnder({ NEXT_PUBLIC_BLOG_TOPOLOGY: topology, NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID: ID })
    expect(moderatedContract('blog').moderated()).toBe(moderated)
    expect(moderatedContract('blog').listsKept().length > 0).toBe(moderated)
  })

  it('takes reports of blogs, posts and comments from v9 on', async () => {
    const v8 = (await contractsUnder({ NEXT_PUBLIC_BLOG_TOPOLOGY: 'v8', NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID: ID })).moderatedContract('blog')
    expect([v8.deletableTypes().includes('report'), v8.reportsResolved(), v8.reportTargets()]).toEqual([false, false, []])
    const v9 = (await contractsUnder({ NEXT_PUBLIC_BLOG_TOPOLOGY: 'v9', NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID: ID })).moderatedContract('blog')
    expect([v9.deletableTypes().includes('report'), v9.reportsResolved()]).toEqual([true, true])
    expect(v9.reportTargets().map((target) => target.docType)).toEqual(['blog', 'blogPost', 'blogComment'])
  })
})

describe('hide, don\'t delete (social v18, blog v10, storefront v11)', () => {
  const SOCIAL = 'Soc1111111111111111111111111111111111111111'
  const BLOG = 'Blg1111111111111111111111111111111111111111'
  const STORE = 'Sto1111111111111111111111111111111111111111'
  const set = (social: string, blog: string, storefront: string) => contractsUnder({
    NEXT_PUBLIC_YAPPR_CONTRACT_ID: SOCIAL, NEXT_PUBLIC_CONTRACT_TOPOLOGY: social,
    NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID: BLOG, NEXT_PUBLIC_BLOG_TOPOLOGY: blog,
    NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: STORE, NEXT_PUBLIC_STOREFRONT_TOPOLOGY: storefront,
  })

  it('reads the v18-set files: nothing deletable, mod and modLabel changeable, warnings only', async () => {
    const { moderatedContract } = await set('v18', 'v10', 'v11')
    const social = moderatedContract('social')
    expect([social.hidesInsteadOfDeleting(), social.restrictsAuthors()]).toEqual([true, true])
    expect(social.deletableTypes()).toEqual([])
    expect(social.hideableTypes()).toEqual(['post', 'reply', 'yapprProfile'])
    expect(social.listsKept()).toEqual(['warnings'])
    expect(social.settledDeletionFor('post')).toBeNull()

    const blog = moderatedContract('blog')
    expect([blog.hidesInsteadOfDeleting(), blog.restrictsAuthors()]).toEqual([true, true])
    expect(blog.deletableTypes()).toEqual([])
    expect(blog.hideableTypes()).toEqual(['blog', 'blogPost', 'blogComment'])
    expect(blog.listsKept()).toEqual(['warnings'])
    expect([blog.settledDeletionFor('blogPost'), blog.keepsRecord('blogPost')]).toEqual([null, false])
    expect(blog.elected()?.moderatedDocumentTypes.blogPost).toEqual(['changeDocumentFields', 'warn'])

    const storefront = moderatedContract('storefront')
    // Storefront v11 has no `live` lane, so no restriction type.
    expect([storefront.hidesInsteadOfDeleting(), storefront.restrictsAuthors()]).toEqual([true, false])
    expect(storefront.deletableTypes()).toEqual([])
    expect(storefront.hideableTypes()).toEqual(['store', 'storeItem', 'storeReview', 'itemReview'])
    expect(storefront.listsKept()).toEqual(['warnings'])
    expect(storefront.reportsResolved()).toBe(true)
    // Stable answers (React effects depend on them).
    expect(storefront.hideableTypes()).toBe(storefront.hideableTypes())
    expect(social.hideableTypes()).toBe(social.hideableTypes())
  })

  it('keeps the delete cuts (social v17, blog v9, storefront v10) exactly as they were', async () => {
    const { moderatedContract } = await set('v17', 'v9', 'v10')
    for (const key of ['social', 'blog', 'storefront'] as const) {
      const contract = moderatedContract(key)
      expect([contract.hidesInsteadOfDeleting(), contract.restrictsAuthors(), contract.hideableTypes()]).toEqual([false, false, []])
      expect(contract.deletableTypes().length).toBeGreaterThan(0)
      expect(contract.listsKept()).toContain('banlist')
    }
    expect(moderatedContract('blog').deletableTypes()).toContain('blogPost')
    expect(moderatedContract('storefront').deletableTypes()).toContain('storeReview')
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

describe('the moderation model the legal copy describes', () => {
  // Every cut the repo carries lets moderators delete content (or, on v2, has
  // no moderation at all), so the copy keeps describing removals on each.
  it.each(['v2', 'v9', 'v16', 'v17'])('keeps the removal wording on social %s', async (topology) => {
    const { moderationHidesOnly } = await contractsUnder({ NEXT_PUBLIC_CONTRACT_TOPOLOGY: topology })
    expect(moderationHidesOnly()).toBe(false)
  })
})
