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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import socialContractV7 from '@/contracts/yappr-social-contract-v7.json'
import socialContractV8 from '@/contracts/yappr-social-contract-v8.json'
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
  it('keeps the e2e spec\'s hand-copied topology order in sync', () => {
    // e2e/ cannot import from lib/ (it reads the COMPILED bundle, and Playwright
    // runs outside the app's module graph), so `TOPOLOGY_ORDER` there is a
    // literal copy. Drift would not error — it would silently skip whole devnet
    // suites, which is exactly what the ordered gates were introduced to stop.
    const spec = readFileSync(join(process.cwd(), 'e2e/write/topology.spec.ts'), 'utf8')
    const literal = spec.match(/const TOPOLOGY_ORDER = \[([^\]]*)\]/)?.[1] ?? ''
    expect(literal, 'e2e/write/topology.spec.ts must declare TOPOLOGY_ORDER').not.toBe('')
    expect(literal.split(',').map((entry) => entry.trim().replace(/'/g, '')))
      .toEqual([...CONTRACT_TOPOLOGIES])
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

  it('turns the attested author off exactly on v4..v6', async () => {
    const enabled: string[] = []
    for (const topology of CONTRACT_TOPOLOGIES) {
      const { authorFieldIsRequired } = await topologyModule(topology)
      if (authorFieldIsRequired()) enabled.push(topology)
    }
    expect(enabled).toEqual(['v4', 'v5', 'v6'])
    // v7 keeps every capability v6 gained; only the author column went away.
    const v7 = await topologyModule('v7')
    expect(v7.likeCountsArePreallocated()).toBe(true)
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
      // v8 declares the same lists, so the same preserve sets hold there.
      expect((await topologyModule('v8')).tombstonePreservationFor(kind)).toEqual(tombstonePreservationFor(kind))
      expect((socialContractV8.documentSchemas[kind] as { immutable: string[] }).immutable).toEqual(doctype(kind).immutable)
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

  describe('v8 grammar', () => {
    it('reports nothing moderated, priced or granted before v8', async () => {
      const v7 = await topologyModule('v7')
      expect(v7.contractIsModerated()).toBe(false)
      expect(v7.referencesMayDangle()).toBe(false)
      expect(v7.moderatorDeletableTypes()).toEqual([])
      expect(v7.declaredActionFee('post', 'create')).toBeNull()
      expect(v7.starterGrantAmount()).toBeNull()
      // The YAPP price is the same number on every priced cut, but before v8
      // it is required and never sponsored.
      expect(v7.tokenCostFor('post')).toEqual({ amount: 10, optional: false, gasFeesPaidBy: 0 })
    })

    it('keeps every v7 capability on v8', async () => {
      const v8 = await topologyModule('v8')
      expect([
        v8.hashtagsAreInline(), v8.hashtagIsOptional(), v8.prefixRankingsAvailable(), v8.followRankingsAvailable(),
        v8.windowedRankingsAvailable(), v8.likesAreIndexOnly(), v8.deletesAreTombstones(), v8.authorFieldIsRequired(),
      ]).toEqual([true, true, true, true, true, true, true, false])
      expect(v8.likeCountsArePreallocated()).toBe(false)
    })

    it('pins the moderation declarations against the v8 JSON', async () => {
      const v8 = await topologyModule('v8')
      expect(v8.contractIsModerated()).toBe(true)
      expect(v8.referencesMayDangle()).toBe(true)
      expect(v8.moderatorDeletableTypes()).toEqual(['post', 'reply'])
      expect(socialContractV8.config).toMatchObject({
        $formatVersion: '2',
        moderation: { banlist: true, suspensions: true, moderators: { $type: 'contractOwner' } },
      })
      // Every reference at a moderator-deletable type is deletable, and no
      // like index is preallocated any more.
      const schemas = socialContractV8.documentSchemas as unknown as Record<string, {
        properties: Record<string, { refersTo?: { type: string; documentType?: string } }>
        indices?: Array<{ preallocated?: boolean }>
      }>
      for (const schema of Object.values(schemas)) {
        for (const property of Object.values(schema.properties)) {
          if (property.refersTo?.documentType && ['post', 'reply'].includes(property.refersTo.documentType)) {
            expect(property.refersTo.type).toBe('deletableDocument')
          }
        }
        expect((schema.indices ?? []).some((index) => index.preallocated)).toBe(false)
      }
    })

    it('pins the free-usage, grant and action-fee numbers against the v8 JSON', async () => {
      const v8 = await topologyModule('v8')
      const sponsored = { optional: true, gasFeesPaidBy: 2 }
      expect(v8.tokenCostFor('post')).toEqual({ amount: 10, ...sponsored })
      expect(v8.tokenCostFor('reply')).toEqual({ amount: 3, ...sponsored })
      expect(v8.tokenCostFor('like')).toEqual({ amount: 1, ...sponsored })
      expect(v8.tokenCostFor('likeReply')).toEqual({ amount: 1, ...sponsored })
      expect(v8.tokenCostFor('repost')).toEqual({ amount: 1, ...sponsored })
      expect(v8.tokenCostFor('follow')).toBeNull()
      expect(v8.tokenCostFor('nope')).toBeNull()

      expect(v8.starterGrantAmount()).toBe(100n)

      // ~$0.05 and ~$0.01 at $60/DASH (1 DASH = 1e11 credits), moderators pot only.
      expect(v8.declaredActionFee('post', 'create')).toEqual({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' })
      expect(v8.declaredActionFee('reply', 'create')).toEqual({ owner: 0n, moderators: 16_000_000n, pricing: 'feeMultiplier' })
      for (const [docType, action] of [['post', 'replace'], ['post', 'delete'], ['like', 'create'], ['repost', 'create'], ['follow', 'create']] as const) {
        expect(v8.declaredActionFee(docType, action)).toBeNull()
      }
    })
  })
})
