import { afterEach, describe, expect, it, vi } from 'vitest'

/** The module under `topology` (STOREFRONT_TOPOLOGY is read at load, so each cut is a fresh import). */
async function load(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology)
  return import('./storefront-contract')
}

afterEach(() => vi.unstubAllEnvs())

describe('store category slugs (v6 store.category)', () => {
  it.each([
    ['Vintage Clothing', 'vintage-clothing'],
    ['  books  ', 'books'],
    ['Café & Bäckerei!', 'cafe-backerei'],
    ['3D printing -- parts', '3d-printing-parts'],
    ['---', ''],
    ['', ''],
  ])('normalises %j to %j', async (input, slug) => {
    const { normalizeStoreCategory, isStoreCategory } = await load('v6')
    expect(normalizeStoreCategory(input)).toBe(slug)
    if (slug) expect(isStoreCategory(slug)).toBe(true)
  })

  it('cuts to 20 characters without leaving a trailing dash', async () => {
    const { normalizeStoreCategory, isStoreCategory, STORE_CATEGORY_MAX_LENGTH } = await load('v6')
    expect(STORE_CATEGORY_MAX_LENGTH).toBe(20)
    const slug = normalizeStoreCategory('handmade wooden toys and games')
    expect(slug).toBe('handmade-wooden-toys')
    expect(normalizeStoreCategory('abcdefghijklmnopqrs tuv')).toBe('abcdefghijklmnopqrs')
    expect(isStoreCategory(slug)).toBe(true)
  })

  it('refuses what the contract pattern refuses', async () => {
    const { isStoreCategory } = await load('v6')
    for (const bad of ['Books', 'vintage clothing', '-books', 'books-', 'a--b', 'x'.repeat(21)]) {
      expect(isStoreCategory(bad), bad).toBe(false)
    }
  })

  it('labels a slug for display', async () => {
    const { storeCategoryLabel } = await load('v6')
    expect(storeCategoryLabel('vintage-clothing')).toBe('Vintage clothing')
  })
})

describe('action fees (storefront v6)', () => {
  it('reads the declared create fees off the committed contract on v6', async () => {
    const { storefrontActionFee, storefrontCreateFeeCredits } = await load('v6')
    expect(storefrontActionFee('store', 'create')).toEqual({ owner: 0n, moderators: 1_000_000_000n, pricing: 'feeMultiplier' })
    expect(storefrontCreateFeeCredits('storeItem')).toBe(50_000_000n)
    expect(storefrontCreateFeeCredits('storeReview')).toBe(16_000_000n)
    expect(storefrontCreateFeeCredits('itemReview')).toBe(8_000_000n)
  })

  it('charges nothing for orders, status updates, deliveries or edits', async () => {
    const { storefrontActionFee } = await load('v6')
    for (const docType of ['storeOrder', 'orderStatusUpdate', 'orderDelivery', 'itemDeliverable', 'shippingZone', 'savedAddress']) {
      expect(storefrontActionFee(docType, 'create'), docType).toBeNull()
    }
    expect(storefrontActionFee('store', 'replace')).toBeNull()
  })

  it('charges nothing before v6, where reviews cost YAPP', async () => {
    const { storefrontActionFee } = await load('v5')
    expect(storefrontActionFee('store', 'create')).toBeNull()
    expect(storefrontActionFee('storeReview', 'create')).toBeNull()
  })

  it('reaches the write path through declaredActionFeeFor for the storefront contract only', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v6')
    vi.stubEnv('NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID', 'storefront-id')
    const { declaredActionFeeFor } = await import('../transition-agreements')
    expect(declaredActionFeeFor('storefront-id', 'storeReview', 'create')?.moderators).toBe(16_000_000n)
    expect(declaredActionFeeFor('some-other-contract', 'storeReview', 'create')).toBeNull()
  })
})

describe('size guards (v6 caps)', () => {
  const variantsOf = (bytes: number) => ({ axes: [{ name: 'Size', options: ['x'.repeat(bytes)] }], combinations: [] })

  it('refuses variants past 5,120 bytes on v6 and lets them through before it', async () => {
    const v6 = await load('v6')
    expect(v6.ITEM_VARIANTS_MAX_BYTES).toBe(5120)
    expect(v6.variantsSizeError(undefined)).toBeNull()
    expect(v6.variantsSizeError(variantsOf(100))).toBeNull()
    expect(v6.variantsSizeError(variantsOf(5200))).toMatch(/more than the 5,120 a listing can store/)
    const v5 = await load('v5')
    expect(v5.variantsSizeError(variantsOf(5200))).toBeNull()
  })

  it('counts variants in UTF-8 bytes, not characters', async () => {
    const { variantsSizeError } = await load('v6')
    // 2,000 three-byte characters: ~6,000 bytes, well under 5,120 characters.
    expect(variantsSizeError({ axes: [{ name: 'Size', options: ['€'.repeat(2000)] }], combinations: [] })).not.toBeNull()
  })

  it('refuses an encrypted order payload past 5,120 bytes on v6 only', async () => {
    const v6 = await load('v6')
    expect(v6.orderPayloadSizeError(5120)).toBeNull()
    expect(v6.orderPayloadSizeError(5121)).toMatch(/too large to send \(5,121 of 5,120 bytes\)/)
    expect((await load('v5')).orderPayloadSizeError(9000)).toBeNull()
  })

  it('caps both digital payloads at the contract value', async () => {
    const { DIGITAL_PAYLOAD_MAX_BYTES } = await load('v6')
    expect(DIGITAL_PAYLOAD_MAX_BYTES).toBe(5120)
  })

  it('accepts only https:// and ipfs:// store images on v6', async () => {
    const v6 = await load('v6')
    expect(v6.isStoreImageUrl('https://example.com/logo.png')).toBe(true)
    expect(v6.isStoreImageUrl('ipfs://bafy')).toBe(true)
    expect(v6.isStoreImageUrl('http://example.com/logo.png')).toBe(false)
    expect((await load('v5')).isStoreImageUrl('http://example.com/logo.png')).toBe(true)
  })
})
