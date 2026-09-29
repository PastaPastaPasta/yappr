import { afterEach, describe, expect, it, vi } from 'vitest'
import { DASHPAY_CONTRACT_ID, YAPPR_CONTRACT_ID, YAPPR_PROFILE_CONTRACT_ID } from '@/lib/constants'
import socialContractV10 from '@/contracts/yappr-social-contract-v10.json'

/** The topology descriptor is cached per module registry, so each cut needs a fresh one. */
async function profileModule(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./v10-profile')
}

afterEach(() => vi.unstubAllEnvs())

const recipe = JSON.stringify({ seed: 'seed', style: 'thumbs' })
const digest = { hash: new Uint8Array(32).fill(1), fingerprint: new Uint8Array(8).fill(2) }

describe('profile sources', () => {
  it.each(['v2', 'v9'])('reads one profile document from the profile contract on %s', async (topology) => {
    const v = await profileModule(topology)
    expect(v.profileSources()).toEqual([{ role: 'base', source: { contractId: YAPPR_PROFILE_CONTRACT_ID, documentType: 'profile' } }])
    expect(v.profileExtensionSource()).toBeNull()
    expect(v.profileTextLimits()).toEqual({ displayName: 50, bio: 160 })
    expect(v.avatarSeedMaxLength()).toBe(100)
  })

  it('reads the DashPay profile, then the social extension, on v10', async () => {
    const v = await profileModule('v10')
    expect(v.profileSources()).toEqual([
      { role: 'base', source: { contractId: DASHPAY_CONTRACT_ID, documentType: 'profile' } },
      { role: 'extension', source: { contractId: YAPPR_CONTRACT_ID, documentType: 'yapprProfile' } },
    ])
    expect(v.profileTextLimits()).toEqual({ displayName: 25, bio: 140 })
  })

  it('keeps the longest custom seed recipe within the extension avatar field', async () => {
    const v = await profileModule('v10')
    const maxLength = (socialContractV10.documentSchemas.yapprProfile.properties.avatar as { maxLength: number }).maxLength
    const longest = JSON.stringify({ seed: 'x'.repeat(v.avatarSeedMaxLength()), style: 'adventurer-neutral' })
    expect(longest.length).toBe(maxLength)
  })
})

describe('mergeV10ProfileRecords', () => {
  const base = { $id: 'dash', $ownerId: 'owner', $createdAt: 1, $revision: 3, displayName: 'Ava', publicMessage: 'hi' }
  const extension = { $id: 'ext', $ownerId: 'owner', $createdAt: 2, $revision: 1, location: 'Lisbon', avatar: recipe, nsfw: false }

  it('takes the name and bio from DashPay and the rest, with the system fields, from the extension', async () => {
    const { mergeV10ProfileRecords } = await profileModule('v10')
    expect(mergeV10ProfileRecords(base, extension)).toEqual({
      $id: 'ext', $ownerId: 'owner', $createdAt: 2, $revision: 1,
      displayName: 'Ava', bio: 'hi', location: 'Lisbon', avatar: recipe, nsfw: false,
    })
  })

  it("prefers DashPay's image avatar over the extension's recipe", async () => {
    const { mergeV10ProfileRecords } = await profileModule('v10')
    expect(mergeV10ProfileRecords({ ...base, avatarUrl: 'https://x/a.png' }, extension)?.avatar).toBe('https://x/a.png')
  })

  it('reads records nested under data, and either document alone', async () => {
    const { mergeV10ProfileRecords } = await profileModule('v10')
    expect(mergeV10ProfileRecords({ $id: 'dash', $ownerId: 'owner', data: { displayName: 'Ava' } }, null))
      .toEqual({ $id: 'dash', $ownerId: 'owner', displayName: 'Ava' })
    expect(mergeV10ProfileRecords(null, extension)).toMatchObject({ $id: 'ext', displayName: '', location: 'Lisbon' })
    expect(mergeV10ProfileRecords(null, null)).toBeNull()
  })
})

describe('planV10ProfileWrite', () => {
  it('creates the DashPay profile and the extension for a new user', async () => {
    const { planV10ProfileWrite } = await profileModule('v10')
    expect(planV10ProfileWrite({
      base: null, extension: null, fallbackAvatar: recipe,
      patch: { displayName: ' Ava ', bio: 'hi', location: 'Lisbon', avatar: recipe, paymentUris: ['dash:x'], socialLinks: [] },
    })).toEqual({
      base: { displayName: 'Ava', publicMessage: 'hi' },
      extension: { location: 'Lisbon', avatar: recipe, paymentUris: ['dash:x'] },
    })
  })

  it('leaves an existing DashPay profile alone and only adds the extension', async () => {
    const { planV10ProfileWrite } = await profileModule('v10')
    const base = { $id: 'dash', displayName: 'Ava', publicMessage: 'hi', avatarUrl: 'https://x/a.png', avatarHash: 'AQ==', avatarFingerprint: [2] }
    expect(planV10ProfileWrite({
      base, extension: null, fallbackAvatar: recipe,
      patch: { displayName: 'Ava', bio: 'hi', avatar: 'https://x/a.png' },
    })).toEqual({ base: null, extension: { avatar: recipe } })
  })

  it('replaces DashPay with the hash and fingerprint of a new image avatar, keeping the fields Yappr does not edit', async () => {
    const { avatarNeedingDigest, planV10ProfileWrite } = await profileModule('v10')
    const address = new Uint8Array(21).fill(9)
    const base = { displayName: 'Ava', corePaymentAddress: address }
    const patch = { avatar: 'ipfs://new' }
    expect(avatarNeedingDigest(base, patch)).toBe('ipfs://new')
    expect(() => planV10ProfileWrite({ base, extension: { avatar: recipe }, fallbackAvatar: recipe, patch })).toThrow(/hash and fingerprint/)
    expect(planV10ProfileWrite({ base, extension: { avatar: recipe }, fallbackAvatar: recipe, patch, avatarDigest: digest })).toEqual({
      base: { displayName: 'Ava', corePaymentAddress: address, avatarUrl: 'ipfs://new', avatarHash: digest.hash, avatarFingerprint: digest.fingerprint },
      extension: null,
    })
  })

  it('drops all three DashPay avatar fields when the user switches to a generated avatar', async () => {
    const { planV10ProfileWrite } = await profileModule('v10')
    const base = { displayName: 'Ava', avatarUrl: 'https://x/a.png', avatarHash: digest.hash, avatarFingerprint: digest.fingerprint }
    const other = JSON.stringify({ seed: 'other', style: 'bottts' })
    expect(planV10ProfileWrite({ base, extension: { avatar: recipe }, fallbackAvatar: recipe, patch: { avatar: other } }))
      .toEqual({ base: { displayName: 'Ava' }, extension: { avatar: other } })
  })

  it('removes cleared extension fields but never writes an empty extension', async () => {
    const { planV10ProfileWrite } = await profileModule('v10')
    const extension = { location: 'Lisbon', paymentUris: ['dash:x'] }
    expect(planV10ProfileWrite({
      base: { displayName: 'Ava' }, extension, fallbackAvatar: recipe, patch: { location: ' ', paymentUris: [] },
    })).toEqual({ base: null, extension: { avatar: recipe } })
  })

  it('writes nothing for an edit that changes nothing', async () => {
    const { planV10ProfileWrite } = await profileModule('v10')
    expect(planV10ProfileWrite({
      base: { displayName: 'Ava' }, extension: { nsfw: true, socialLinks: ['github:a'] }, fallbackAvatar: recipe,
      patch: { displayName: 'Ava', nsfw: true, socialLinks: ['github:a'] },
    })).toEqual({ base: null, extension: null })
  })

  it("refuses what DashPay or the extension would refuse, before signing", async () => {
    const { planV10ProfileWrite } = await profileModule('v10')
    const plan = (patch: Record<string, unknown>) => () =>
      planV10ProfileWrite({ base: null, extension: null, fallbackAvatar: recipe, patch: { displayName: 'Ava', ...patch } })
    expect(plan({ displayName: 'x'.repeat(26) })).toThrow(/at most 25/)
    expect(plan({ bio: 'x'.repeat(141) })).toThrow(/at most 140/)
    expect(plan({ displayName: ' ' })).toThrow(/required/)
    expect(plan({ avatar: JSON.stringify({ seed: 'x'.repeat(107), style: 'thumbs' }) })).toThrow(/at most 128/)
    // 25 characters of emoji are 50 UTF-16 units, and still fit.
    expect(plan({ displayName: '😀'.repeat(25) })).not.toThrow()
  })
})
