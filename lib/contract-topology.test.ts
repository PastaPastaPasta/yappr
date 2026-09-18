/**
 * The topology descriptor is the app's model of a contract that lives on
 * chain, so the parts of it that consensus ENFORCES have to be pinned against
 * the contract JSON rather than reviewed by eye.
 *
 * The expensive one is the tombstone preserve set. From v7 the `post` and
 * `reply` doctypes declare `immutable` lists, and a replace that changes, adds
 * OR DROPS a frozen property is rejected with 40128 — so a preserve set that
 * has drifted below the contract's list turns every delete into a hard
 * failure, at runtime, on chain. This test makes that drift a red unit test.
 */
import { describe, expect, it, vi } from 'vitest'
import socialContractV7 from '@/contracts/yappr-social-contract-v7.json'
import { CONTRACT_TOPOLOGIES } from './constants'

/** The doctype schema as the committed JSON declares it. */
function doctype(name: 'post' | 'reply') {
  return socialContractV7.documentSchemas[name] as unknown as {
    immutable: string[]
    immutableAllowSetting: string[]
    required: string[]
    properties: Record<string, { contentMediaType?: string }>
  }
}

/**
 * The module caches its descriptor on first use, so each topology needs a
 * fresh module registry as well as a fresh env var.
 */
async function topologyModule(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./contract-topology')
}

describe('contract topology', () => {
  it('resolves every declared topology to its own descriptor', async () => {
    for (const topology of CONTRACT_TOPOLOGIES) {
      const { topologyDescriptor } = await topologyModule(topology)
      expect(topologyDescriptor().topology).toBe(topology)
    }
    // An unrecognized value must fall back rather than resolve to undefined.
    const { topologyDescriptor } = await topologyModule('v99')
    expect(topologyDescriptor().topology).toBe('v2')
  })

  it('turns the attested author off exactly on v4..v6', async () => {
    const enabled: string[] = []
    for (const topology of CONTRACT_TOPOLOGIES) {
      const { authorFieldIsRequired } = await topologyModule(topology)
      if (authorFieldIsRequired()) enabled.push(topology)
    }
    expect(enabled).toEqual(['v4', 'v5', 'v6'])
    // v7 keeps every capability v6 gained; only the author column went away.
    const v7 = await topologyModule('v7')
    expect([
      v7.hashtagsAreInline(),
      v7.hashtagIsOptional(),
      v7.prefixRankingsAvailable(),
      v7.followRankingsAvailable(),
      v7.windowedRankingsAvailable(),
      v7.likesAreIndexOnly(),
      v7.deletesAreTombstones(),
    ]).toEqual([true, true, true, true, true, true, true])
    expect(v7.hashtagMaxLength()).toBe(61)
    expect(v7.beatCompanionFor('post', 'dash')).toEqual({ docType: 'beat' })
    expect(v7.beatCompanionFor('post', '')).toBeNull()
  })

  it.each(['post', 'reply'] as const)(
    'preserves exactly the v7 contract\'s immutable properties when tombstoning a %s',
    async (kind) => {
      const { tombstonePreservationFor } = await topologyModule('v7')
      const { identifiers, scalars } = tombstonePreservationFor(kind)
      const schema = doctype(kind)

      // `deleted` is the one frozen property the tombstone SETS rather than
      // copies; the contract allows that first set via immutableAllowSetting.
      expect(schema.immutableAllowSetting).toEqual(['deleted'])
      expect([...identifiers, ...scalars].sort()).toEqual(
        schema.immutable.filter((name) => name !== 'deleted').sort()
      )

      // The two buckets exist because identifiers are re-encoded to raw bytes
      // and scalars are not, so a field in the wrong one corrupts the write.
      const isIdentifier = (name: string) =>
        schema.properties[name]?.contentMediaType === 'application/x.dash.dpp.identifier'
      expect(identifiers.filter((name) => !isIdentifier(name))).toEqual([])
      expect(scalars.filter(isIdentifier)).toEqual([])
    }
  )

  it('never preserves a property the tombstone has to blank', async () => {
    const { tombstonePreservationFor } = await topologyModule('v7')
    const blanked = ['content', 'mediaUrl', 'sensitive', 'encryptedContent', 'epoch', 'nonce']
    for (const kind of ['post', 'reply'] as const) {
      const { identifiers, scalars } = tombstonePreservationFor(kind)
      expect([...identifiers, ...scalars].filter((name) => blanked.includes(name))).toEqual([])
      expect(doctype(kind).immutable.filter((name) => blanked.includes(name))).toEqual([])
    }
  })

  it('stops writing the author column on v7 while v6 still requires it', async () => {
    expect(doctype('post').required).not.toContain('author')
    expect(doctype('post').properties.author).toBeUndefined()
    expect(doctype('reply').required).not.toContain('author')
    expect(doctype('reply').properties.author).toBeUndefined()

    // ...and the v6 preserve set still names it, so older deployments keep
    // producing valid tombstones from the same code path.
    const { tombstonePreservationFor } = await topologyModule('v6')
    expect(tombstonePreservationFor('post').identifiers).toContain('author')
    expect(tombstonePreservationFor('reply').identifiers).toContain('author')
  })
})
