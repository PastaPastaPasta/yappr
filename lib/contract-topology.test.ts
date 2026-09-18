/**
 * The topology descriptor is the app's model of a contract that lives on
 * chain, so the parts of it that consensus ENFORCES have to be pinned against
 * the contract JSON rather than reviewed by eye.
 *
 * The expensive one is the tombstone preserve set. The v7 `post` and `reply`
 * doctypes declare `immutable` lists, and a replace that changes, adds
 * OR DROPS a frozen property is rejected with 40128 — so a preserve set that
 * has drifted below the contract's list turns every delete into a hard
 * failure, at runtime, on chain. This test makes that drift a red unit test.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import socialContractV7 from '@/contracts/yappr-social-contract-v7.json'
import { CONTRACT_TOPOLOGIES, DEFAULT_CONTRACT_TOPOLOGY } from './constants'

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
  it('keeps the e2e spec\'s hand-copied devnet topology in sync', () => {
    // e2e/ cannot import from lib/ (it reads the COMPILED bundle, and Playwright
    // runs outside the app's module graph), so `DEVNET_TOPOLOGY` there is a
    // literal copy. Drift would not error — it would silently skip every devnet
    // suite, which is exactly what the gate was introduced to stop.
    const spec = readFileSync(join(process.cwd(), 'e2e/write/topology.spec.ts'), 'utf8')
    const literal = spec.match(/const DEVNET_TOPOLOGY = '([^']*)'/)?.[1] ?? ''
    expect(literal, 'e2e/write/topology.spec.ts must declare DEVNET_TOPOLOGY').not.toBe('')
    expect([literal]).toEqual(
      CONTRACT_TOPOLOGIES.filter((topology) => topology !== DEFAULT_CONTRACT_TOPOLOGY)
    )
  })

  it('resolves every declared topology to its own descriptor', async () => {
    for (const topology of CONTRACT_TOPOLOGIES) {
      const { topologyDescriptor } = await topologyModule(topology)
      expect(topologyDescriptor().topology).toBe(topology)
    }
    // An unrecognized value must fall back rather than resolve to undefined.
    const { topologyDescriptor } = await topologyModule('v99')
    expect(topologyDescriptor().topology).toBe('v2')
  })

  it('enables every v7 capability and none of them on v2', async () => {
    const capabilities = (module: Awaited<ReturnType<typeof topologyModule>>) => [
      module.hashtagsAreInline(),
      module.hashtagIsOptional(),
      module.prefixRankingsAvailable(),
      module.followRankingsAvailable(),
      module.windowedRankingsAvailable(),
      module.likesAreIndexOnly(),
      module.deletesAreTombstones(),
      module.referencesAreEnforced(),
      module.hasFlatThreads(),
      module.quoteFieldsAreSplit(),
      module.likeSurfacesAreSplit(),
    ]
    const v7 = await topologyModule('v7')
    expect(capabilities(v7)).toEqual(Array(11).fill(true))
    expect(v7.beatCompanionFor('post', 'dash')).toEqual({ docType: 'beat' })
    expect(v7.beatCompanionFor('post', '')).toBeNull()
    expect(v7.beatCompanionFor('reply', 'dash')).toBeNull()
    expect(v7.quoteListingOrderProperty()).toBe('$createdAt')

    const v2 = await topologyModule('v2')
    expect(capabilities(v2)).toEqual(Array(11).fill(false))
    expect(v2.beatCompanionFor('post', 'dash')).toBeNull()
    expect(v2.quoteListingOrderProperty()).toBe('$ownerId')
  })

  it.each(['post', 'reply'] as const)(
    'preserves exactly the contract\'s immutable properties when tombstoning a %s',
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

  it('declares no attested author column, so nothing may write one', () => {
    for (const kind of ['post', 'reply'] as const) {
      expect(doctype(kind).required).not.toContain('author')
      expect(doctype(kind).properties.author).toBeUndefined()
    }
  })
})
