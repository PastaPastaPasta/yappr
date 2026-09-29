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
import socialContractV10 from '@/contracts/yappr-social-contract-v10.json'
import { CONTRACT_TOPOLOGIES } from './constants'

type Schemas = Record<string, {
  immutable?: string[]
  immutableAllowSetting?: string[]
  required?: string[]
  indices?: Array<{ name: string; preallocated?: boolean; skipIfAbsent?: boolean | string[]; unique?: boolean; rangeCountable?: boolean; rankedCountable?: boolean | { at: string | string[] }; properties: Array<Record<string, string>> }>
  moderatorAbilities?: { delete?: boolean; deleteKeepsRecord?: boolean; changeFields?: string[] }
  dependentRequired?: Record<string, string[]>
  documentsMutable?: boolean
  canBeDeleted?: boolean
  tokenCost?: { create?: { amount: number } }
  actionFees?: Record<string, unknown>
  properties: Record<string, {
    contentMediaType?: string
    maxLength?: number
    maxBytes?: number
    refersTo?: { type: string; documentType?: string; lookup?: unknown; where?: Record<string, string>; findBy?: Record<string, string>; contractId?: string }
    items?: { refersTo?: unknown }
    maxItems?: number
  }>
  ownerRefersTo?: unknown
  propertyConstraints?: Record<string, unknown>
}>

const V9 = socialContractV9.documentSchemas as unknown as Schemas
const V10 = socialContractV10.documentSchemas as unknown as Schemas
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
  it('declares exactly the social contract shapes the repo carries', () => {
    expect([...CONTRACT_TOPOLOGIES]).toEqual(['v2', 'v9', 'v10'])
    // e2e/write/topology.spec.ts runs on whichever devnet cut .env.devnet names
    // (every topology but v2); a devnet env naming v2 would silently skip it.
    const devnetEnv = readFileSync(join(process.cwd(), '.env.devnet'), 'utf8')
    const devnetTopology = devnetEnv.match(/^NEXT_PUBLIC_CONTRACT_TOPOLOGY=(\S+)/m)?.[1]
    expect(CONTRACT_TOPOLOGIES.filter((topology) => topology !== 'v2')).toContain(devnetTopology)
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
      m.contractKeepsWarnings(), m.privateFeedWritesAreGated(), m.blockFollowsAreTyped(), m.contractTakesReports(),
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
    for (const [topology, schemas] of [['v2', V2], ['v9', V9], ['v10', V10]] as const) {
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

  it('declares a tombstone rule that forbids exactly what the tombstone blanks, and nothing it preserves', async () => {
    // `tombstoneIsBlank` (beta.6 form): deleted: true ⇒ content of length 0 (`length`
    // reads an absent one as 0), no mediaUrl, no encryptedContent. `tombstoneDocument`
    // writes content '' and drops the rest, so a preserve set naming a forbidden property
    // would turn every delete into a 10422.
    const { tombstonePreservationFor } = await topologyModule('v9')
    for (const kind of ['post', 'reply'] as const) {
      const rule = JSON.stringify(V9[kind].propertyConstraints?.tombstoneIsBlank ?? null)
      const forbidden = [
        ...[...rule.matchAll(/"absent":"(\w+)"/g)].map(([, name]) => name),
        ...[...rule.matchAll(/"equal":\[\{"length":"(\w+)"\},0\]/g)].map(([, name]) => name),
      ]
      expect(forbidden.sort(), kind).toEqual(['content', 'encryptedContent', 'mediaUrl'])
      const { identifiers, scalars } = tombstonePreservationFor(kind)
      const preserved = [...identifiers, ...scalars]
      expect(preserved.filter((name) => forbidden.includes(name)), kind).toEqual([])
      // The tombstone drops the whole encryption triple, so `privateAllOrNone` holds
      // (all absent); preserving part of it would make every private delete a 10422.
      const triple = ['encryptedContent', 'epoch', 'nonce']
      expect(V9[kind].propertyConstraints?.privateAllOrNone, kind).toBeDefined()
      expect(preserved.filter((name) => triple.includes(name)), kind).toEqual([])
    }
    // An embed is preserved whole or not at all, so `embedAllOrNone` holds on a tombstone.
    const { identifiers, scalars } = tombstonePreservationFor('post')
    const embed = ['embedContractId', 'embedDocType', 'embedId']
    expect(V9.post.propertyConstraints?.embedAllOrNone).toBeDefined()
    expect(embed.filter((name) => [...identifiers, ...scalars].includes(name)).sort()).toEqual([...embed].sort())
    // A quote target is preserved with its owner, so `quoteNamesOwner` holds on a tombstone.
    expect(identifiers).toEqual(expect.arrayContaining(['quotedPostId', 'quotedReplyId', 'quotedPostOwnerId']))
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
      expect(v9.moderatorDeletableTypes()).toEqual(['post', 'reply', 'report'])
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
        joinWindowSeconds: 3_600,
        voteWindowSeconds: 3_600,
        seatContestable: false,
        electionDelaySeconds: null,
        maxAddedModerators: 10,
        moderatedDocumentTypes: { post: abilities, reply: abilities, report: ['deleteDocuments'] },
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
  describe('v10 (4.2.0-beta.7)', () => {
    it('keeps every v9 interaction surface, and v2 and v9 behave as before', async () => {
      // A descriptor resolves on first use, from the env at that moment, so each
      // module is read before the next one is loaded.
      const surfaces = (m: Awaited<ReturnType<typeof topologyModule>>) => ({
        linkage: m.replyLinkage(),
        kinds: (['post', 'reply'] as const).map((kind) => [m.likeIndexFor(kind), m.repostIndexFor(kind), m.bookmarkIndexFor(kind),
          m.quoteFieldFor(kind), m.replyCountFieldFor(kind), m.indexOnlyLikeShapeFor(kind)]),
      })
      const shared = (m: Awaited<ReturnType<typeof topologyModule>>) => [
        m.hasFlatThreads(), m.quoteFieldsAreSplit(), m.likeSurfacesAreSplit(), m.referencesAreEnforced(), m.likesAreIndexOnly(),
        m.hashtagsAreInline(), m.prefixRankingsAvailable(), m.followRankingsAvailable(), m.windowedRankingsAvailable(),
        m.contractIsModerated(), m.referencesMayDangle(), m.contractKeepsWarnings(), m.privateFeedWritesAreGated(),
        m.blockFollowsAreTyped(), m.contractTakesReports(),
      ]
      const only10 = (m: Awaited<ReturnType<typeof topologyModule>>) => [
        m.isV10(), m.mediaCarriesHashes(), m.reportsAreResolved(), m.yappIsLocked(), m.dashpayProfileExtension() !== null, !m.postsHaveLanguage(),
        m.repostsAreQuotes(), m.ownQuoteIndexFor('post') !== null, m.replyCountNeedsRoot('reply'),
        m.authorPostCountsAreRanked(),
      ]
      const read = async (topology: string) => {
        const m = await topologyModule(topology)
        return { surfaces: surfaces(m), shared: shared(m), only10: only10(m) }
      }
      const [v2, v9, v10] = [await read('v2'), await read('v9'), await read('v10')]
      // v9's surfaces but two: no repost doctype (a repost is a quote), and the
      // reply indexes all start at the root.
      const [v9Post, v9Reply] = v9.surfaces.kinds
      expect(v10.surfaces).toEqual({
        linkage: { ...v9.surfaces.linkage, nestedUnderRoot: true },
        kinds: [[v9Post[0], null, ...v9Post.slice(2)], v9Reply],
      })
      expect(v9.surfaces.linkage.nestedUnderRoot).toBe(false)
      expect(v10.shared.every(Boolean)).toBe(true)
      expect(v10.only10.every(Boolean)).toBe(true)
      expect(v9.only10.some(Boolean)).toBe(false)
      expect(v2.only10.some(Boolean)).toBe(false)
    })

    it('deletes instead of tombstoning, and writes no beat', async () => {
      const v10 = await topologyModule('v10')
      expect(v10.deletesAreTombstones()).toBe(false)
      expect(v10.tombstonePreservationFor('post')).toEqual({ identifiers: [], scalars: [] })
      expect(v10.clearableReferencesFor('post')).toEqual([])
      expect(v10.beatCompanionFor('post', 'dash')).toBeNull()
      expect(V10.beat).toBeUndefined()
      for (const kind of ['post', 'reply'] as const) {
        expect(V10[kind].documentsMutable, kind).toBe(false)
        expect(V10[kind].canBeDeleted, kind).toBeUndefined()
        expect(V10[kind].properties.deleted, kind).toBeUndefined()
        expect(V10[kind].immutable, kind).toBeUndefined()
      }
      expect(socialContractV10.config.documentsCanBeDeletedContractDefault).toBe(true)
    })

    it('pins the rolling like windows: 72h/24h top posts, 24h/6h trending tags, no creator window', async () => {
      const likeIndex = (name: string) => V10.like.indices?.find((index) => index.name === name) as
        ({ properties: Array<Record<string, string>>; skipIfAbsent?: boolean; timeRange?: Record<string, unknown> } | undefined)
      expect(V10.like.indices?.map((index) => index.name)).toEqual(['byPost', 'byHashtagPost', 'byAuthorPost', 'byAuthorTimePost', 'byLiker', 'byTrendPost', 'byTrendHashtagPost'])
      const posts = likeIndex('byTrendPost')
      expect(posts?.properties.map((entry) => Object.keys(entry)[0])).toEqual(['$createdAt', 'postId'])
      expect(posts?.timeRange).toEqual({ on: '$createdAt', range: 259_200, step: 86_400, ttl: 604_800 })
      const tags = likeIndex('byTrendHashtagPost')
      expect(tags?.properties.map((entry) => Object.keys(entry)[0])).toEqual(['$createdAt', 'hashtag', 'postId'])
      expect(tags?.timeRange).toEqual({ on: '$createdAt', range: 86_400, step: 21_600, ttl: 604_800 })
      expect(tags?.skipIfAbsent).toBe(true)
      // The all-time twin must stay (and skip too): #5162 refuses an indexOnly optional
      // property without an untimed single-skip index.
      expect(likeIndex('byHashtagPost')?.skipIfAbsent).toBe(true)
      // likeReply has no window to move.
      expect(V10.likeReply.indices?.some((index) => (index as { timeRange?: unknown }).timeRange)).toBe(false)

      const v10 = await topologyModule('v10')
      expect(v10.windowedRankingFor('posts')).toEqual({ docType: 'like', index: 'byTrendPost', grid: { range: 259_200, step: 86_400 }, selector: 'oldest', label: '3 days' })
      expect(v10.windowedRankingFor('hashtags')).toEqual({ docType: 'like', index: 'byTrendHashtagPost', grid: { range: 86_400, step: 21_600 }, selector: 'oldest', label: '24h' })
      expect(v10.windowedRankingFor('creators')).toBeNull()
      const v9 = await topologyModule('v9')
      const day = { grid: { range: 86_400, step: 86_400 }, selector: 'newest', label: 'Today' }
      expect(v9.windowedRankingFor('posts')).toEqual({ docType: 'like', index: 'byDayPost', ...day })
      expect(v9.windowedRankingFor('hashtags')).toEqual({ docType: 'beat', index: 'byDayHashtagPost', ...day })
      expect(v9.windowedRankingFor('creators')).toEqual({ docType: 'like', index: 'byDayAuthorPost', ...day })
      expect((await topologyModule('v2')).windowedRankingFor('posts')).toBeNull()
    })

    it('pins content limits, media hashes and the key-generation rename against the v10 JSON', async () => {
      const v10 = await topologyModule('v10')
      expect(v10.contentLimits()).toEqual({ maxLength: 1000, maxBytes: 2000, encryptedMaxBytes: 2048 })
      expect((await topologyModule('v9')).contentLimits()).toEqual({ maxLength: 500, maxBytes: null, encryptedMaxBytes: 1024 })
      for (const kind of ['post', 'reply'] as const) {
        expect(V10[kind].properties.content).toMatchObject({ maxLength: 1000, maxBytes: 2000 })
        expect(V10[kind].properties.language, kind).toBeUndefined()
        expect(V10[kind].dependentRequired).toEqual({ mediaUrl: ['mediaHash', 'mediaFingerprint'], mediaHash: ['mediaUrl'], mediaFingerprint: ['mediaUrl'] })
        expect(V10[kind].properties.mediaHash).toMatchObject({ byteArray: true, minItems: 32, maxItems: 32 })
        expect(V10[kind].properties.mediaFingerprint).toMatchObject({ byteArray: true, minItems: 8, maxItems: 8 })
      }
      const { generation, latest } = v10.privateFeedKeyFields()
      for (const docType of ['post', 'reply', 'privateFeedGrant', 'privateFeedRekey']) {
        expect(V10[docType].properties[generation], docType).toBeDefined()
        expect(V10[docType].properties.epoch, docType).toBeUndefined()
      }
      expect(V10.privateFeedState.properties[latest]).toBeDefined()
      expect(V10.privateFeedRekey.indices?.map((index) => index.name)).toEqual(['ownerAndKeyGeneration'])
      expect((await topologyModule('v9')).privateFeedKeyFields()).toEqual({ generation: 'epoch', latest: 'maxEpoch' })
      expect(V10.post.indices?.find((index) => index.name === 'timeline')?.properties).toEqual([{ $createdAt: 'asc' }])
    })

    it('pins the moderation declaration, report resolution and abilities against the v10 JSON', async () => {
      const v10 = await topologyModule('v10')
      const abilities = ['deleteDocuments', 'ban', 'suspend', 'warn']
      expect(v10.electedModeration()).toEqual({
        joinWindowSeconds: 3_600,
        voteWindowSeconds: 3_600,
        seatContestable: false,
        electionDelaySeconds: null,
        maxAddedModerators: 10,
        moderatedDocumentTypes: { post: abilities, reply: abilities, report: ['deleteDocuments', 'changeDocumentFields'], yapprProfile: ['deleteDocuments'] },
        interim: 'contractOwner',
        ownerProtected: true,
      })
      expect(v10.moderatorDeletableTypes()).toEqual(['post', 'reply', 'report', 'yapprProfile'])
      expect(v10.reportResolutionFields()).toEqual(['status', 'resolution'])
      // Posts, replies and profiles keep their removal record (restorable); reports do not.
      expect(['post', 'reply', 'yapprProfile', 'report'].map((type) => v10.moderatorDeletionKeepsRecord(type))).toEqual([true, true, true, false])
      expect((await topologyModule('v9')).moderatorDeletionKeepsRecord('report')).toBe(true)
      expect((await topologyModule('v9')).reportResolutionFields()).toEqual([])
      expect(V10.report.properties.status).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 })
      expect(V10.report.properties.resolution).toMatchObject({ type: 'string', minLength: 1, maxLength: 200 })
      expect(V10.report.required).not.toContain('status')
      expect(V10.report.indices?.map((index) => index.name)).toEqual(expect.arrayContaining(['byStatus', 'byModerator']))
      expect(socialContractV10.documentSchemas.report.ttl).toBe(7_776_000)
      // Nothing is left of the beta.6 grammar.
      const text = JSON.stringify(socialContractV10)
      for (const removed of ['canBeDeletedByModerators', 'propertyAgreement', '"lookup"', 'listElement']) expect(text).not.toContain(removed)
    })

    it('pins the yapprProfile extension to the DashPay profile', async () => {
      const v10 = await topologyModule('v10')
      expect(v10.dashpayProfileExtension()).toEqual({ base: { contractId: 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7', documentType: 'profile' }, extensionDocType: 'yapprProfile' })
      expect(V10.yapprProfile.ownerRefersTo).toEqual({ type: 'deletableDocument', contractId: v10.DASHPAY_PROFILE.contractId, documentType: 'profile', findBy: { $ownerId: '.' } })
      expect(V10.profile).toBeUndefined()
      expect(Object.keys(V10.yapprProfile.properties).sort()).toEqual(['avatar', 'bannerUri', 'location', 'nsfw', 'paymentUris', 'pronouns', 'socialLinks', 'website'])
    })

    it('pins the translated references: each where is the v9 agreement flipped', () => {
      const flip = (agreement: Record<string, string>) => Object.fromEntries(Object.entries(agreement).map(([mine, its]) => [its, mine]))
      const legacy = (schema: Schemas[string], property: string) => (schema.properties[property].refersTo as { propertyAgreement?: Record<string, string> }).propertyAgreement
      // (v9's repost.postId has no v10 twin: the doctype is gone, see the reposts-as-quotes test.)
      for (const [docType, property] of [['like', 'postId'], ['likeReply', 'replyId'], ['post', 'quotedPostId'], ['post', 'quotedReplyId'], ['reply', 'replyToReplyId'], ['report', 'postId'], ['report', 'replyId']]) {
        expect(V10[docType].properties[property].refersTo?.where, `${docType}.${property}`).toEqual(flip(legacy(V9[docType], property) ?? {}))
      }
      expect(V10.privateFeedGrant.properties.recipientId.refersTo?.findBy).toEqual({ targetId: '$ownerId', $ownerId: '.' })
    })

    it('locks YAPP: paused for good, never priced, still granted, costs unchanged', async () => {
      const v10 = await topologyModule('v10')
      const token = socialContractV10.tokens['0']
      expect(token.startAsPaused).toBe(true)
      expect(token.emergencyActionRules.authorizedToMakeChange.$type).toBe('noOne')
      expect(token.emergencyActionRules.adminActionTakers.$type).toBe('noOne')
      expect(token.distributionRules.changeDirectPurchasePricingRules.authorizedToMakeChange.$type).toBe('noOne')
      expect(token.distributionRules.changeDirectPurchasePricingRules.adminActionTakers.$type).toBe('noOne')
      expect(token.manualMintingRules.authorizedToMakeChange.$type).toBe('contractOwner')
      expect(token.distributionRules.mintingAllowChoosingDestination).toBe(true)
      expect(v10.starterGrantAmount()).toBe(100n)
      const sponsored = { optional: true, gasFeesPaidBy: 2 }
      for (const [docType, amount] of [['post', 10], ['reply', 3], ['like', 1], ['likeReply', 1]] as const) {
        expect(v10.tokenCostFor(docType), docType).toEqual({ amount, ...sponsored })
      }
      // A repost is a post, priced as one.
      expect(v10.tokenCostFor('repost')).toBeNull()
      expect(v10.declaredActionFee('post', 'create')).toEqual({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' })
      expect(v10.declaredActionFee('reply', 'create')).toEqual({ owner: 0n, moderators: 16_000_000n, pricing: 'feeMultiplier' })
      expect(v10.declaredActionFee('post', 'delete')).toBeNull()
      expect((await topologyModule('v9')).yappIsLocked()).toBe(false)
    })

    it('makes reposts quotes: no repost doctype, one quote or repost per author and target', async () => {
      const v10 = await topologyModule('v10')
      expect(V10.repost).toBeUndefined()
      expect(v10.repostIndexFor('post')).toBeNull()
      expect(v10.repostIndexFor('reply')).toBeNull()
      // Posts AND replies can be reposted, through the quote fields.
      expect([v10.canRepost('post'), v10.canRepost('reply')]).toEqual([true, true])
      const index = (docType: string, name: string) => V10[docType].indices?.find((entry) => entry.name === name)
      const keys = (docType: string, name: string) => index(docType, name)?.properties.map((entry) => Object.keys(entry)[0])
      for (const kind of ['post', 'reply'] as const) {
        const own = v10.ownQuoteIndexFor(kind)
        expect(own, kind).not.toBeNull()
        if (!own) continue
        expect(own.field).toBe(v10.quoteFieldFor(kind))
        expect(keys(own.docType, own.index), own.index).toEqual(['$ownerId', own.field])
        expect(index(own.docType, own.index)).toMatchObject({ unique: true, skipIfAbsent: true })
        // The quote count (the repost count) is the rangeCountable listing index.
        const listing = kind === 'post' ? 'quotesOfPost' : 'quotesOfReply'
        expect(keys('post', listing)).toEqual([own.field, '$createdAt'])
        expect(index('post', listing)?.rangeCountable).toBe(true)
      }
      // The notification source for reposts and quotes of my posts.
      expect(keys('post', 'quotedPostOwnerAndTime')).toEqual(['quotedPostOwnerId', '$createdAt'])
      // An empty post is refused unless it quotes (or carries media/ciphertext/an embed).
      expect(JSON.stringify(V10.post.propertyConstraints?.notEmpty)).toContain('"present":"quotedReplyId"')
      const v9 = await topologyModule('v9')
      expect([v9.repostsAreQuotes(), v9.ownQuoteIndexFor('post'), v9.canRepost('reply')]).toEqual([false, null, false])
      expect(v9.repostIndexFor('post')).toEqual({ docType: 'repost', field: 'postId', ownerFirst: true, ownerField: 'postOwnerId' })
      const v2 = await topologyModule('v2')
      expect([v2.repostsAreQuotes(), v2.ownQuoteIndexFor('post'), v2.canRepost('reply')]).toEqual([false, null, true])
    })

    it('merges the count indexes into their list twins', () => {
      const names = (docType: string) => V10[docType].indices?.map((entry) => entry.name)
      const index = (docType: string, name: string) => V10[docType].indices?.find((entry) => entry.name === name)
      const keys = (docType: string, name: string) => index(docType, name)?.properties.map((entry) => Object.keys(entry)[0])
      for (const removed of ['quoteCount', 'quoteReplyCount', 'byOwner']) expect(names('post'), removed).not.toContain(removed)
      for (const removed of ['rootAndTime', 'byRoot', 'replyToReplyAndTime', 'byReplyToReply']) expect(names('reply'), removed).not.toContain(removed)
      for (const removed of ['followerCount', 'followingCount']) expect(names('follow'), removed).not.toContain(removed)
      // Posts per author: `$ownerId ==` counts and the ranked top authors.
      expect(keys('post', 'ownerAndTime')).toEqual(['$ownerId', '$createdAt'])
      expect(index('post', 'ownerAndTime')).toMatchObject({ rangeCountable: true, rankedCountable: { at: '$ownerId' } })
      // One reply index, rooted: every reply read pins rootPostId.
      expect(keys('reply', 'repliesOf')).toEqual(['rootPostId', 'replyToReplyId', '$createdAt'])
      expect(index('reply', 'repliesOf')).toMatchObject({ rangeCountable: true, rankedCountable: { at: 'rootPostId' } })
      expect(index('reply', 'repliesOf')?.skipIfAbsent).toBeUndefined()
      expect(V10.reply.required).toContain('rootPostId')
      expect(keys('follow', 'followers')).toEqual(['followingId', '$createdAt'])
      expect(index('follow', 'followers')).toMatchObject({ rangeCountable: true, rankedCountable: { at: 'followingId' } })
      expect(keys('follow', 'following')).toEqual(['$ownerId', '$createdAt'])
      expect(index('follow', 'following')?.rangeCountable).toBe(true)
    })

    it('counts a reply\'s children only under its root, and a post\'s thread by root alone', async () => {
      const v10 = await topologyModule('v10')
      expect([v10.replyCountNeedsRoot('post'), v10.replyCountNeedsRoot('reply')]).toEqual([false, true])
      expect([v10.replyCountFieldFor('post'), v10.replyCountFieldFor('reply')]).toEqual(['rootPostId', 'replyToReplyId'])
      expect(v10.targetOf({ id: 'r', targetKind: 'reply', rootPostId: 'root' })).toEqual({ id: 'r', kind: 'reply', rootPostId: 'root' })
      // A post is its own root: nothing to carry.
      expect(v10.targetOf({ id: 'p', rootPostId: 'ignored' })).toEqual({ id: 'p', kind: 'post' })
      const v9 = await topologyModule('v9')
      expect([v9.replyCountNeedsRoot('reply'), v9.replyLinkage().nestedUnderRoot, v9.authorPostCountsAreRanked()]).toEqual([false, false, false])
    })

    it('puts skipIfAbsent on every stored index over an optional property only', () => {
      for (const [docType, schema] of Object.entries(V10)) {
        const required = new Set(schema.required ?? [])
        for (const index of schema.indices ?? []) {
          const optional = index.properties.map((entry) => Object.keys(entry)[0]).filter((name) => !name.startsWith('$') && !required.has(name))
          // byStatus stays unskipped: an open report has no status, and a skip index
          // could not serve the `status == null` side of the queue. repliesOf too:
          // a direct reply has no replyToReplyId and must sit under the null branch.
          const expected = optional.length > 0 && index.name !== 'byStatus' && index.name !== 'repliesOf'
          expect(index.skipIfAbsent === true, `${docType}.${index.name}`).toBe(expected)
        }
      }
    })
  })
})
