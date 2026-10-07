import { afterEach, describe, expect, it, vi } from 'vitest'
import blogContract from '@/contracts/yappr-blog-contract.json'
import { YAPPR_BLOG_CONTRACT_ID, YAPPR_CONTRACT_ID } from '@/lib/constants'
import { declaredActionFeeFor } from '@/lib/transition-agreements'
import { blogActionFee, blogTrendWindow } from './blog-contract'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('blog v7 action fees', () => {
  it('agrees to the declared moderators fee on blog, post and comment creates', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v7')
    expect(blogActionFee('blog', 'create')).toEqual({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' })
    expect(blogActionFee('blogPost', 'create')).toEqual({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' })
    expect(blogActionFee('blogComment', 'create')).toEqual({ owner: 0n, moderators: 16_000_000n, pricing: 'feeMultiplier' })
  })

  it('charges nothing for a follow, an edit, a tombstone or a delete', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v7')
    expect(blogActionFee('blogFollow', 'create')).toBeNull()
    expect(blogActionFee('blogPost', 'replace')).toBeNull()
    expect(blogActionFee('blogComment', 'delete')).toBeNull()
  })

  it('charges nothing before v7, whatever the checked-in file says', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v6')
    expect(blogActionFee('blogComment', 'create')).toBeNull()
  })

  it('the write path names the blog fee only for the blog contract', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v7')
    expect(declaredActionFeeFor(YAPPR_BLOG_CONTRACT_ID, 'blogComment', 'create')?.moderators).toBe(16_000_000n)
    expect(declaredActionFeeFor('some-other-contract', 'blogComment', 'create')).toBeNull()
    // The social contract has no blogComment type to price.
    expect(declaredActionFeeFor(YAPPR_CONTRACT_ID, 'blogComment', 'create')).toBeNull()
  })

  it('the checked-in contract carries no token cost any more', () => {
    for (const schema of Object.values(blogContract.documentSchemas)) expect(schema).not.toHaveProperty('tokenCost')
  })
})

describe('blog v7 trend windows', () => {
  it('read the 72h grid stepping every 24h off the contract, for followers and comments alike', () => {
    expect(blogTrendWindow('followers')).toEqual({ grid: { range: 259200, step: 86400 }, selector: 'oldest' })
    expect(blogTrendWindow('comments')).toEqual({ grid: { range: 259200, step: 86400 }, selector: 'oldest' })
  })
})
