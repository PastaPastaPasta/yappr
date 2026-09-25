/**
 * The topology descriptor is the app's model of a contract that lives on
 * chain, so the parts of it that consensus ENFORCES have to be pinned against
 * the contract JSON rather than reviewed by eye.
 *
 * The expensive one is the tombstone preserve set. The v9 `post` and `reply`
 * doctypes declare `immutable` lists, and a replace that changes, adds OR
 * DROPS a frozen property is rejected with 40128 — so a preserve set that has
 * drifted below the contract's list turns every delete into a hard failure,
 * at runtime, on chain. This test makes that drift a red unit test.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import socialContractV2 from '@/contracts/yappr-social-contract-v2.json'
import socialContractV9 from '@/contracts/yappr-social-contract-v9.json'
import { CONTRACT_TOPOLOGIES } from './constants'

type Schemas = Record<string, {
  immutable?: string[]
  immutableAllowSetting?: string[]
  required?: string[]
  indices?: Array<{ preallocated?: boolean }>
  tokenCost?: { create?: { amount: number } }
  actionFees?: Record<string, unknown>
  properties: Record<string, {
    contentMediaType?: string
    maxLength?: number
    refersTo?: { type: string; documentType?: string; lookup?: unknown }
    items?: { refersTo?: unknown }
    maxItems?: number
  }>
  ownerRefersTo?: unknown
}>

const V9 = socialContractV9.documentSchemas as unknown as Schemas
const V2 = socialContractV2.documentSchemas as unknown as Schemas

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
  it('declares exactly the two social contracts that exist on chain', () => {
    expect([...CONTRACT_TOPOLOGIES]).toEqual(['v2', 'v9'])
    // The e2e spec reads the COMPILED bundle and cannot import lib/, so it
    // names the devnet topology as a literal; drift would silently skip it.
    const spec = readFileSync(join(process.cwd(), 'e2e/write/topology.spec.ts'), 'utf8')
    expect(spec.match(/const DEVNET_TOPOLOGY = '([^']+)'/)?.[1]).toBe('v9')
    const devnetEnv = readFileSync(join(process.cwd(), '.env.devnet'), 'utf8')
    expect(devnetEnv.match(/^NEXT_PUBLIC_CONTRACT_TOPOLOGY=(\S+)/m)?.[1]).toBe('v9')
  })

  it('resolves every declared topology to its own descriptor, and v2 when unset', async () => {
    for (const topology of CONTRACT_TOPOLOGIES) {
      const { topologyDescriptor } = await topologyModule(topology)
      expect(topologyDescriptor().topology).toBe(topology)
    }
    const { topologyDescriptor } = await topologyModule('')
    expect(topologyDescriptor().topology).toBe('v2')
  })

  it('refuses a topology that is set but unknown, instead of building a v2 client', async () => {
    // A retired cut named in a stale env file must fail the build, not ship a
    // v2 client pointed at a contract of another shape.
    for (const retired of ['v8', 'v7', 'v3', 'v99']) {
      const { topologyDescriptor } = await topologyModule(retired)
      expect(() => topologyDescriptor(), retired).toThrow(/NEXT_PUBLIC_CONTRACT_TOPOLOGY="v\d+" is not a topology/)
    }
  })

  it('reports every v9 capability on v9 and none of them on v2', async () => {
    const capabilities = (m: Awaited<ReturnType<typeof topologyModule>>) => [
      m.hasFlatThreads(), m.quoteFieldsAreSplit(), m.likeSurfacesAreSplit(), m.referencesAreEnforced(),
      m.deletesAreTombstones(), m.likesAreIndexOnly(), m.hashtagsAreInline(), m.prefixRankingsAvailable(),
      m.followRankingsAvailable(), m.windowedRankingsAvailable(), m.contractIsModerated(), m.referencesMayDangle(),
      m.contractKeepsWarnings(), m.privateFeedWritesAreGated(), m.blockFollowsAreTyped(),
    ]
    const v9 = await topologyModule('v9')
    expect(capabilities(v9).every(Boolean)).toBe(true)
    expect(v9.quoteListingOrderProperty()).toBe('$createdAt')
    expect(v9.beatCompanionFor('post', 'dash')).toEqual({ docType: 'beat' })
    expect(v9.beatCompanionFor('post', '')).toBeNull()
    expect(v9.beatCompanionFor('reply', 'dash')).toBeNull()
    expect([v9.canRepost('reply'), v9.canBookmark('reply')]).toEqual([false, false])

    const v2 = await topologyModule('v2')
    expect(capabilities(v2).some(Boolean)).toBe(false)
    expect(v2.quoteListingOrderProperty()).toBe('$ownerId')
    expect(v2.beatCompanionFor('post', 'dash')).toBeNull()
    expect([v2.canRepost('reply'), v2.canBookmark('reply')]).toEqual([true, true])
    // v2 keeps one polymorphic surface, so a mixed page is ONE group.
    expect(v2.groupByInteractionSurface([{ id: 'a', kind: 'post' }, { id: 'b', kind: 'reply' }])).toHaveLength(1)
    expect(v9.groupByInteractionSurface([{ id: 'a', kind: 'post' }, { id: 'b', kind: 'reply' }])).toHaveLength(2)
  })

  it('pins the hashtag ceiling against the v9 contract pattern', () => {
    return topologyModule('v9').then(({ HASHTAG_MAX_LENGTH }) => {
      for (const docType of ['post', 'like', 'beat']) {
        expect(V9[docType].properties.hashtag.maxLength, docType).toBe(HASHTAG_MAX_LENGTH)
      }
    })
  })

  it('names like fields and indexes that exist on each contract', async () => {
    for (const [topology, schemas] of [['v2', V2], ['v9', V9]] as const) {
      const m = await topologyModule(topology)
      for (const kind of ['post', 'reply'] as const) {
        const like = m.likeIndexFor(kind)
        expect(schemas[like.docType]?.properties[like.field], `${topology} ${kind} like.${like.field}`).toBeDefined()
        if (like.ownerField) expect(schemas[like.docType].properties[like.ownerField], `${topology} ${like.ownerField}`).toBeDefined()
        const shape = m.indexOnlyLikeShapeFor(kind)
        if (shape) {
          expect(schemas[like.docType].properties[shape.authorField]).toBeDefined()
          if (shape.hashtagField) expect(schemas[like.docType].properties[shape.hashtagField]).toBeDefined()
        }
      }
    }
  })

  it.each(['post', 'reply'] as const)(
    'preserves exactly the v9 contract\'s immutable properties when tombstoning a %s',
    async (kind) => {
      const { tombstonePreservationFor } = await topologyModule('v9')
      const { identifiers, scalars } = tombstonePreservationFor(kind)
      const schema = V9[kind]

      // `deleted` is the one frozen property the tombstone SETS rather than
      // copies; the contract allows that first set via immutableAllowSetting.
      expect(schema.immutableAllowSetting).toEqual(['deleted'])
      expect([...identifiers, ...scalars].sort()).toEqual(
        (schema.immutable ?? []).filter((name) => name !== 'deleted').sort()
      )

      // The two buckets exist because identifiers are re-encoded to raw bytes
      // and scalars are not, so a field in the wrong one corrupts the write.
      const isIdentifier = (name: string) =>
        schema.properties[name]?.contentMediaType === 'application/x.dash.dpp.identifier'
      expect(identifiers.filter((name) => !isIdentifier(name))).toEqual([])
      expect(scalars.filter(isIdentifier)).toEqual([])
    }
  )

  it('never preserves a property the tombstone has to blank, and preserves nothing on v2', async () => {
    const { tombstonePreservationFor } = await topologyModule('v9')
    const blanked = ['content', 'mediaUrl', 'sensitive', 'encryptedContent', 'epoch', 'nonce']
    for (const kind of ['post', 'reply'] as const) {
      const { identifiers, scalars } = tombstonePreservationFor(kind)
      expect([...identifiers, ...scalars].filter((name) => blanked.includes(name))).toEqual([])
      expect((V9[kind].immutable ?? []).filter((name) => blanked.includes(name))).toEqual([])
      // No attested author column: likes bind to the target's $ownerId.
      expect(V9[kind].properties.author).toBeUndefined()
    }
    const v2 = await topologyModule('v2')
    expect(v2.tombstonePreservationFor('post')).toEqual({ identifiers: [], scalars: [] })
  })

  describe('moderation, costs, fees and the grant', () => {
    it('reports nothing moderated, fee-charged or granted on v2, with the v9 amounts as REQUIRED costs', async () => {
      const v2 = await topologyModule('v2')
      expect(v2.moderatorDeletableTypes()).toEqual([])
      expect(v2.moderationListsKept()).toEqual([])
      expect(v2.clearableReferencesFor('post')).toEqual([])
      expect(v2.declaredActionFee('post', 'create')).toBeNull()
      expect(v2.starterGrantAmount()).toBeNull()
      expect(v2.electedModeration()).toBeNull()
      expect(v2.ownerDistinctProperties('follow')).toEqual([])
      expect(v2.tokenCostFor('post')).toEqual({ amount: 10, optional: false, gasFeesPaidBy: 0 })
    })

    it('reads v2 token amounts that match the v2 contract', async () => {
      // `tokenCostFor` reads the v9 JSON whatever the configured topology, so an
      // edit to v9's amounts would silently change what a v2 (testnet) client
      // sends. Pin them together.
      const v2 = await topologyModule('v2')
      for (const [docType, schema] of Object.entries(V2)) {
        const declared = schema.tokenCost?.create?.amount
        expect(v2.tokenCostFor(docType)?.amount ?? null, `${docType} token cost`).toBe(declared ?? null)
      }
    })

    it('pins the moderation declarations against the v9 JSON', async () => {
      const v9 = await topologyModule('v9')
      expect(v9.moderatorDeletableTypes()).toEqual(['post', 'reply'])
      expect(v9.moderationListsKept()).toEqual(['banlist', 'suspensions', 'warnings'])
      expect(socialContractV9.config.$formatVersion).toBe('2')
      // Every reference at a moderator-deletable type is deletable, and no
      // like index is preallocated.
      for (const schema of Object.values(V9)) {
        for (const property of Object.values(schema.properties)) {
          if (property.refersTo?.documentType && ['post', 'reply'].includes(property.refersTo.documentType)) {
            expect(property.refersTo.type).toBe('deletableDocument')
          }
        }
        expect((schema.indices ?? []).some((index) => index.preallocated)).toBe(false)
      }
    })

    it('names exactly the optional deletable references a tombstone may clear', async () => {
      const v9 = await topologyModule('v9')
      expect(v9.clearableReferencesFor('post')).toEqual(['quotedPostId', 'quotedReplyId'])
      // rootPostId is a deletable reference too, but required: it can never be cleared.
      expect(v9.clearableReferencesFor('reply')).toEqual(['replyToReplyId'])
      expect(v9.clearableReferencesFor('like')).toEqual([])
      // Every clearable reference is one the tombstone would otherwise preserve.
      for (const kind of ['post', 'reply'] as const) {
        for (const name of v9.clearableReferencesFor(kind)) expect(v9.tombstonePreservationFor(kind).identifiers).toContain(name)
      }
    })

    it('pins the free-usage, grant and action-fee numbers against the v9 JSON', async () => {
      const v9 = await topologyModule('v9')
      const sponsored = { optional: true, gasFeesPaidBy: 2 }
      expect(v9.tokenCostFor('post')).toEqual({ amount: 10, ...sponsored })
      expect(v9.tokenCostFor('reply')).toEqual({ amount: 3, ...sponsored })
      expect(v9.tokenCostFor('like')).toEqual({ amount: 1, ...sponsored })
      expect(v9.tokenCostFor('likeReply')).toEqual({ amount: 1, ...sponsored })
      expect(v9.tokenCostFor('repost')).toEqual({ amount: 1, ...sponsored })
      expect(v9.tokenCostFor('follow')).toBeNull()
      expect(v9.tokenCostFor('nope')).toBeNull()

      expect(v9.starterGrantAmount()).toBe(100n)

      // ~$0.05 and ~$0.01 at $60/DASH (1 DASH = 1e11 credits), moderators pot only.
      expect(v9.declaredActionFee('post', 'create')).toEqual({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' })
      expect(v9.declaredActionFee('reply', 'create')).toEqual({ owner: 0n, moderators: 16_000_000n, pricing: 'feeMultiplier' })
      for (const [docType, action] of [['post', 'replace'], ['post', 'delete'], ['like', 'create'], ['repost', 'create'], ['follow', 'create']] as const) {
        expect(v9.declaredActionFee(docType, action)).toBeNull()
      }
      // The write path can only agree to a fee on CREATE (the facade's replace
      // and delete carry no agreement, and the tombstone path is a replace), so
      // a cut pricing any other action would turn every tombstone into a paid
      // 40132. Pin that no type prices anything but create.
      for (const [name, schema] of Object.entries(V9)) {
        const priced = Object.keys(schema.actionFees ?? {}).filter((key) => key !== 'pricing')
        expect(priced, `${name} prices an action the client cannot agree to`).toEqual(schema.actionFees ? ['create'] : [])
      }
    })
  })

  describe('elected moderation and the beta.4 grammar', () => {
    it('hands out ONE frozen declaration object (effects depend on its identity)', async () => {
      const v9 = await topologyModule('v9')
      expect(v9.electedModeration()).toBe(v9.electedModeration())
      expect(Object.isFrozen(v9.electedModeration())).toBe(true)
    })

    it('pins the elected moderation declaration against the v9 JSON', async () => {
      const v9 = await topologyModule('v9')
      const abilities = ['deleteDocuments', 'ban', 'suspend', 'warn']
      expect(v9.electedModeration()).toEqual({
        joinWindowSeconds: 86_400,
        voteWindowSeconds: 86_400,
        seatContestable: false,
        electionDelaySeconds: null,
        maxAddedModerators: 10,
        moderatedDocumentTypes: { post: abilities, reply: abilities },
        interim: 'contractOwner',
        ownerProtected: true,
      })
    })

    it('pins distinctFrom and the private-feed gates against the v9 JSON', async () => {
      const v9 = await topologyModule('v9')
      expect(v9.ownerDistinctProperties('follow')).toEqual(['followingId'])
      expect(v9.ownerDistinctProperties('block')).toEqual(['blockedId'])
      expect(v9.ownerDistinctProperties('followRequest')).toEqual(['targetId'])
      expect(v9.ownerDistinctProperties('privateFeedGrant')).toEqual(['recipientId'])
      expect(v9.ownerDistinctProperties('blockFollow')).toEqual(['followedBlockers'])
      // Self-likes and self-reposts stay allowed.
      expect(v9.ownerDistinctProperties('like')).toEqual([])
      expect(v9.ownerDistinctProperties('repost')).toEqual([])
      const feedStateGate = { type: 'permanentDocument', documentType: 'privateFeedState', lookup: { index: 'owner', keys: { $ownerId: '.' } } }
      expect(V9.privateFeedGrant.ownerRefersTo).toEqual(feedStateGate)
      expect(V9.privateFeedRekey.ownerRefersTo).toEqual(feedStateGate)
      expect(V9.privateFeedGrant.properties.recipientId.refersTo).toEqual({
        type: 'deletableDocument',
        documentType: 'followRequest',
        lookup: { index: 'targetAndRequester', keys: { targetId: '$ownerId', $ownerId: '.' } },
      })
      // The client's MAX_BLOCK_FOLLOWS is the contract's cap.
      expect(V9.blockFollow.properties.followedBlockers.maxItems).toBe(100)
      expect(V9.blockFollow.properties.followedBlockers.items?.refersTo).toEqual({ type: 'identity' })
    })
  })
})
