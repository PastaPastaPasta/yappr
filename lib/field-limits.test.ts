import { afterEach, describe, expect, it, vi } from 'vitest'
import { fieldLimits } from './field-limits'
import blog from '@/contracts/yappr-blog-contract.json'
import storefront from '@/contracts/yappr-storefront-contract.json'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
describe('schema field limits', () => {
  it('follows the configured social topology rather than pinning v17', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v16')
    vi.resetModules()
    const older = await import('./field-limits')
    expect(older.fieldLimits('social', 'report', 'note').maxBytes).toBeUndefined()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v17')
    vi.resetModules()
    const latest = await import('./field-limits')
    expect(latest.fieldLimits('social', 'report', 'note').maxBytes).toBe(1500)
    expect(latest.fieldLimits('social', 'yapprProfile', 'avatar')).toEqual({ maxLength: 128, maxBytes: 384 })
  })
  it('reads text, URL and array-element caps directly from the schemas', () => {
    expect(fieldLimits('blog', 'blog', 'name')).toEqual({ maxLength: 64, maxBytes: blog.documentSchemas.blog.properties.name.maxBytes })
    expect(fieldLimits('blog', 'blogPost', 'coverImage').maxBytes).toBe(256)
    expect(fieldLimits('storefront', 'storeItem', 'imageUrls[]').maxBytes).toBe(storefront.documentSchemas.storeItem.properties.imageUrls.items.maxBytes)
    expect(fieldLimits('blog', 'blog', 'labels[]')).toEqual({ maxLength: 40, maxBytes: 160 })
  })
})
