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
import socialContractV11 from '@/contracts/yappr-social-contract-v11.json'
import socialContractV12 from '@/contracts/yappr-social-contract-v12.json'
import socialContractV13 from '@/contracts/yappr-social-contract-v13.json'
import socialContractV14 from '@/contracts/yappr-social-contract-v14.json'
import socialContractV15 from '@/contracts/yappr-social-contract-v15.json'
import socialContractV16 from '@/contracts/yappr-social-contract-v16.json'
import socialContractV17 from '@/contracts/yappr-social-contract-v17.json'
import socialContractV18 from '@/contracts/yappr-social-contract-v18.json'
import blogContractV10 from '@/contracts/yappr-blog-contract-v10.json'
import storefrontContractV11 from '@/contracts/yappr-storefront-contract-v11.json'
import blocksContract from '@/contracts/yappr-blocks-contract.json'
import { CONTRACT_TOPOLOGIES } from './constants'

type Schemas = Record<string, {
  immutable?: string[]
  immutableAllowSetting?: string[]
  required?: string[]
  retractedWhen?: unknown
  indices?: Array<{ name: string; summableOffCountIndex?: string; preallocated?: boolean; skipIfAbsent?: boolean | string[]; unique?: boolean; rangeCountable?: boolean; rankedCountable?: boolean | { at: string | string[] }; timeRange?: Record<string, unknown>; properties: Array<Record<string, string>> }>
  moderatorAbilities?: { delete?: boolean; deleteKeepsRecord?: boolean; changeFields?: string[] }
  dependentRequired?: Record<string, string[]>
  documentsMutable?: boolean
  canBeDeleted?: boolean
  tokenCost?: { create?: { amount: number } }
  actionFees?: Record<string, unknown>
  deleteConstraints?: Record<string, unknown>
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
const V11 = socialContractV11.documentSchemas as unknown as Schemas
const V12 = socialContractV12.documentSchemas as unknown as Schemas
const V13 = socialContractV13.documentSchemas as unknown as Schemas
const V14 = socialContractV14.documentSchemas as unknown as Schemas
const V15 = socialContractV15.documentSchemas as unknown as Schemas
const V16 = socialContractV16.documentSchemas as unknown as Schemas
const V17 = socialContractV17.documentSchemas as unknown as Schemas
const V18 = socialContractV18.documentSchemas as unknown as Schemas
const BLOCKS = blocksContract as unknown as Schemas
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
    expect([...CONTRACT_TOPOLOGIES]).toEqual(['v2', 'v9', 'v10', 'v11', 'v12', 'v13', 'v14', 'v15', 'v16', 'v17', 'v18'])
    // e2e/write/topology.spec.ts runs on whichever devnet cut .env.devnet names
    // (every topology but v2); a devnet env naming v2 would silently skip it.
    const devnetEnv = readFileSync(join(process.cwd(), '.env.devnet'), 'utf8')
    const devnetTopology = devnetEnv.match(/^NEXT_PUBLIC_CONTRACT_TOPOLOGY=(\S+)/m)?.[1]
    expect(CONTRACT_TOPOLOGIES.filter((topology) => topology !== 'v2')).toContain(devnetTopology)
    // /devnet rehearses the release cut on sakura's protocol-14 chain.
    expect(devnetTopology).toBe('v17')
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
      m.contractKeepsWarnings(), m.blockFollowsAreTyped(), m.contractTakesReports(),
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
    for (const [topology, schemas] of [['v2', V2], ['v9', V9], ['v10', V10], ['v11', V11], ['v12', V12], ['v13', V13], ['v14', V14], ['v15', V15], ['v16', V16], ['v17', V17]] as const) {
      const m = await topologyModule(topology)
      for (const kind of ['post', 'reply'] as const) {
        const like = m.likeIndexFor(kind)
        expect(schemas[like.docType]?.properties[like.field], `${topology} ${kind} like.${like.field}`).toBeDefined()
        if (like.ownerField) expect(schemas[like.docType].properties[like.ownerField], `${topology} ${like.ownerField}`).toBeDefined()
        const shape = m.indexOnlyLikeShapeFor(kind)
        if (shape) {
          if (shape.authorField) expect(schemas[like.docType].properties[shape.authorField]).toBeDefined()
          else expect(Object.keys(schemas[like.docType].properties), `${topology} ${like.docType} names its target alone`).toEqual([like.field])
          if (shape.hashtagField) expect(schemas[like.docType].properties[shape.hashtagField]).toBeDefined()
        }
      }
    }
  })

  it('pins the like read indexes against each contract: liked state, author-time, design C', async () => {
    type Index = { name: string; properties: Array<Record<string, string>>; terminal?: string; unique?: boolean; rangeCountable?: boolean; rankedCountable?: unknown }
    const indexOf = (schemas: Schemas, docType: string, name: string) =>
      (schemas[docType].indices as Index[] | undefined)?.find((index) => index.name === name)
    const keys = (index: Index | undefined) => index?.properties.map((entry) => Object.keys(entry)[0])

    for (const [topology, schemas] of [['v9', V9], ['v10', V10]] as const) {
      const m = await topologyModule(topology)
      for (const kind of ['post', 'reply'] as const) {
        const like = m.likeIndexFor(kind)
        const shape = m.indexOnlyLikeShapeFor(kind)
        if (!shape?.authorTimeIndex) throw new Error(`${topology} ${kind} likes must be indexOnly with an author-time index`)
        expect(shape.deleteNamesCreatedAt, `${topology} ${kind}`).toBe(true)
        // The author-time index: author, then (v10) the target, and $createdAt,
        // with the liker as the terminal.
        const authorTime = indexOf(schemas, like.docType, shape.authorTimeIndex)
        expect(keys(authorTime), `${topology} ${shape.authorTimeIndex}`).toEqual(shape.authorTimeKeysTarget
          ? [shape.authorField, like.field, '$createdAt']
          : [shape.authorField, '$createdAt', like.field])
        expect(authorTime?.terminal).toBe('$ownerId')
        // The liked-state index: v9 owner-first byLiker, v10 the target-first
        // count index with $ownerId as its terminal.
        const names = (schemas[like.docType].indices as Index[]).map((index) => index.name)
        if (like.ownerIsTerminal) {
          expect(names, `${topology} ${like.docType}`).not.toContain('byLiker')
          const target = (schemas[like.docType].indices as Index[]).find((index) => keys(index)?.join() === like.field)
          expect(target?.terminal, `${topology} ${like.docType} [${like.field}]`).toBe('$ownerId')
          expect(like.ownerFirst).toBe(false)
        } else {
          expect(keys(indexOf(schemas, like.docType, 'byLiker'))).toEqual(['$ownerId'])
          expect(indexOf(schemas, like.docType, 'byLiker')?.terminal).toBe(like.field)
          expect(like.ownerFirst).toBe(true)
        }
      }
      expect(m.likeNotificationsPinTarget()).toBe(topology === 'v10')
      expect(m.likeNotificationsAreTimeless()).toBe(false)
    }

    // v10: byAuthorPostTime replaces byAuthorPost and byAuthorTimePost, keeping
    // the ranked chain at [postAuthor, postId] (creators and a profile's top).
    const authorPostTime = indexOf(V10, 'like', 'byAuthorPostTime')
    expect(authorPostTime?.rangeCountable).toBe(true)
    expect(authorPostTime?.rankedCountable).toEqual({ at: ['postAuthor', 'postId'] })
    expect(V10.likeReply.indices?.map((index) => index.name)).toEqual(['byReply', 'byAuthorReplyTime'])
    const v2 = await topologyModule('v2')
    expect([v2.likeNotificationsPinTarget(), v2.likeNotificationsAreTimeless(), v2.likeIndexFor('post').ownerIsTerminal]).toEqual([false, false, undefined])

    // v11: the author index loses $createdAt, so no like index keeps a like's
    // time; the liked state and the ranked chain are v10's.
    const v11 = await topologyModule('v11')
    for (const [kind, docType, author, target, index] of [['post', 'like', 'postAuthor', 'postId', 'byAuthorPost'], ['reply', 'likeReply', 'replyAuthor', 'replyId', 'byAuthorReply']] as const) {
      const shape = v11.indexOnlyLikeShapeFor(kind)
      expect([shape?.authorTimeIndex, shape?.deleteNamesCreatedAt, shape?.authorTimeKeysTarget], kind).toEqual([null, false, true])
      expect(v11.likeIndexFor(kind)).toEqual({ ...v11.likeIndexFor(kind), docType, field: target, ownerFirst: false, ownerIsTerminal: true })
      expect(keys(indexOf(V11, docType, index)), `v11 ${index}`).toEqual([author, target])
      expect(indexOf(V11, docType, index)?.terminal).toBe('$ownerId')
      const timed = (V11[docType].indices as Index[]).filter((entry) => keys(entry)?.includes('$createdAt'))
      expect(timed.every((entry) => (entry as { outlivesDelete?: boolean }).outlivesDelete === true), `v11 ${docType}: every index on $createdAt outlives deletes`).toBe(true)
    }
    expect(indexOf(V11, 'like', 'byAuthorPost')?.rankedCountable).toEqual({ at: ['postAuthor', 'postId'] })
    expect(indexOf(V11, 'like', 'byAuthorPost')?.rangeCountable).toBe(true)
    expect(V11.likeReply.required).toEqual(['replyId', 'replyAuthor'])
    expect([v11.likeNotificationsPinTarget(), v11.likeNotificationsAreTimeless()]).toEqual([true, true])

    // v12: the same author indexes, kept as counters of the target index
    // (no terminal, no entries); the liked state and the timeless diff are v11's.
    const v12 = await topologyModule('v12')
    for (const [kind, docType, author, target, index, source] of [['post', 'like', 'postAuthor', 'postId', 'byAuthorPost', 'byPost'], ['reply', 'likeReply', 'replyAuthor', 'replyId', 'byAuthorReply', 'byReply']] as const) {
      expect(v12.indexOnlyLikeShapeFor(kind), kind).toEqual({ ...v11.indexOnlyLikeShapeFor(kind), authorIndexIsCounter: true })
      expect(v12.likeIndexFor(kind)).toEqual(v11.likeIndexFor(kind))
      const counter = indexOf(V12, docType, index) as (Index & { summableOffCountIndex?: string }) | undefined
      expect(keys(counter), `v12 ${index}`).toEqual([author, target])
      expect([counter?.summableOffCountIndex, counter?.terminal], `v12 ${index}`).toEqual([source, undefined])
      expect(keys(indexOf(V12, docType, source)), `v12 ${source}`).toEqual([target])
      expect(indexOf(V12, docType, source)?.terminal).toBe('$ownerId')
    }
    expect(indexOf(V12, 'like', 'byAuthorPost')?.rankedCountable).toEqual({ at: ['postAuthor', 'postId'] })
    expect(indexOf(V12, 'like', 'byHashtagPost')?.rankedCountable).toEqual({ at: ['hashtag', 'postId'] })
    expect([v12.likeNotificationsPinTarget(), v12.likeNotificationsAreTimeless()]).toEqual([true, true])
  })

  it('reads the author index as a counter exactly where the contract keeps one (summableOffCountIndex)', async () => {
    for (const [topology, schemas] of [['v9', V9], ['v10', V10], ['v11', V11], ['v12', V12], ['v13', V13], ['v14', V14], ['v15', V15], ['v16', V16], ['v17', V17]] as const) {
      const m = await topologyModule(topology)
      for (const kind of ['post', 'reply'] as const) {
        const shape = m.indexOnlyLikeShapeFor(kind)
        if (!shape) throw new Error(`${topology} ${kind} likes must be indexOnly`)
        const { docType } = m.likeIndexFor(kind)
        // v13 likeReply names no author and keeps no author index.
        if (shape.authorField === null) {
          expect(shape.authorIndexIsCounter, `${topology} ${kind}`).toBe(false)
          expect(schemas[docType].indices?.map((index) => index.name), `${topology} ${kind}`).toEqual(['byReply'])
          continue
        }
        // The author index: the one keyed [author, target] (v11, v12), else the author-time one.
        const authorIndex = schemas[docType].indices?.find((index) => {
          const names = index.properties.map((entry) => Object.keys(entry)[0])
          return names[0] === shape.authorField && !names.includes('$createdAt')
        }) ?? schemas[docType].indices?.find((index) => index.name === shape.authorTimeIndex)
        expect(authorIndex, `${topology} ${kind}`).toBeDefined()
        expect(shape.authorIndexIsCounter, `${topology} ${kind}`).toBe(typeof authorIndex?.summableOffCountIndex === 'string')
      }
    }
    expect((await topologyModule('v2')).indexOnlyLikeShapeFor('post')).toBeNull()
  })

  it('lets a barred author tombstone exactly where post and reply declare retractedWhen on deleted', async () => {
    for (const [topology, schemas] of [['v2', V2], ['v9', V9], ['v10', V10], ['v11', V11], ['v12', V12], ['v13', V13], ['v14', V14], ['v15', V15], ['v16', V16], ['v17', V17]] as const) {
      const m = await topologyModule(topology)
      const declared = (['post', 'reply'] as const).map((kind) => schemas[kind].retractedWhen)
      const retracts = declared.every((rule) => JSON.stringify(rule) === JSON.stringify({ present: 'deleted' }))
      // Both or neither: a half-declared pair would make the predicate lie for one kind.
      if (!retracts) expect(declared, topology).toEqual([undefined, undefined])
      expect(m.barredAuthorsCanTombstone(), topology).toBe(retracts)
      // A retraction is only ever a tombstone.
      if (retracts) expect(m.deletesAreTombstones(), topology).toBe(true)
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
        challengeCoolDownSeconds: null,
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
        m.contractIsModerated(), m.referencesMayDangle(), m.contractKeepsWarnings(),
        m.blockFollowsAreTyped(), m.contractTakesReports(),
      ]
      const only10 = (m: Awaited<ReturnType<typeof topologyModule>>) => [
        m.isV10(), m.mediaCarriesHashes(), m.reportsAreResolved(), m.yappIsLocked(), m.dashpayProfileExtension() !== null, !m.postsHaveLanguage(),
        m.repostsAreQuotes(), m.ownQuoteIndexFor('post') !== null, m.replyCountNeedsRoot('reply'),
        m.authorPostCountsAreRanked(), m.mentionsAreInline(), m.notificationsAreWindowed(),
      ]
      const read = async (topology: string) => {
        const m = await topologyModule(topology)
        return { surfaces: surfaces(m), shared: shared(m), only10: only10(m) }
      }
      const [v2, v9, v10] = [await read('v2'), await read('v9'), await read('v10')]
      // v9's surfaces but three: no repost doctype (a repost is a quote), the
      // reply indexes all start at the root, and likes are design C (no
      // byLiker: target-first liked state, target-pinned author-time index).
      const [v9Post, v9Reply] = v9.surfaces.kinds
      const designC = (like: unknown, shape: unknown, authorTimeIndex: string) => [
        { ...(like as object), ownerFirst: false, ownerIsTerminal: true },
        { ...(shape as object), authorTimeIndex, authorTimeKeysTarget: true },
      ]
      const [postLike, postShape] = designC(v9Post[0], v9Post[5], 'byAuthorPostTime')
      const [replyLike, replyShape] = designC(v9Reply[0], v9Reply[5], 'byAuthorReplyTime')
      expect(v10.surfaces).toEqual({
        linkage: { ...v9.surfaces.linkage, nestedUnderRoot: true },
        kinds: [
          [postLike, null, ...v9Post.slice(2, 5), postShape],
          [replyLike, ...v9Reply.slice(1, 5), replyShape],
        ],
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
      expect(V10.like.indices?.map((index) => index.name)).toEqual(['byPost', 'byHashtagPost', 'byAuthorPostTime', 'byTrendPost', 'byTrendHashtagPost'])
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
      // Like notifications stay permanent (per target on v10): the node cannot
      // rebuild indexOnly documents from a windowed entry, so likeReply has no
      // window at all.
      expect(V10.likeReply.indices?.some((index) => (index as { timeRange?: unknown }).timeRange)).toBe(false)

      const v10 = await topologyModule('v10')
      expect(v10.windowedRankingFor('posts')).toEqual({ docType: 'like', index: 'byTrendPost', grid: { range: 259_200, step: 86_400 }, selector: 'oldest' })
      expect(v10.windowedRankingFor('hashtags')).toEqual({ docType: 'like', index: 'byTrendHashtagPost', grid: { range: 86_400, step: 21_600 }, selector: 'oldest' })
      expect(v10.windowedRankingFor('creators')).toBeNull()
      const v9 = await topologyModule('v9')
      const day = { grid: { range: 86_400, step: 86_400 }, selector: 'newest' }
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
      expect(V10.post.indices?.find((index) => index.name === 'timeline')?.properties).toEqual([{ $createdAt: 'asc' }])
    })

    it('pins the moderation declaration, report resolution and abilities against the v10 JSON', async () => {
      const v10 = await topologyModule('v10')
      const abilities = ['deleteDocuments', 'ban', 'suspend', 'warn']
      expect(v10.electedModeration()).toEqual({
        joinWindowSeconds: 3_600,
        voteWindowSeconds: 3_600,
        seatContestable: false,
        challengeCoolDownSeconds: null,
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

    it('reads "YAPP can pay a token cost" off the configured cut: paused for good on v10–v13 only', async () => {
      for (const topology of ['v10', 'v11', 'v12', 'v13']) {
        const m = await topologyModule(topology)
        expect([m.yappIsPausedForGood(), m.yappIsLocked()], topology).toEqual([true, true])
      }
      for (const topology of ['v2', 'v9']) {
        const m = await topologyModule(topology)
        expect([m.yappIsPausedForGood(), m.yappIsLocked()], topology).toEqual([false, false])
      }
      // v14 and v15 pay token costs in YAPP again, but YAPP is still never bought or sent.
      for (const topology of ['v14', 'v15']) {
        const m = await topologyModule(topology)
        expect([m.yappIsPausedForGood(), m.yappIsLocked()], topology).toEqual([false, true])
      }
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
      // The notification source for reposts and quotes of my posts (a rolling window).
      expect(keys('post', 'quotedPostOwnerRecent')).toEqual(['$createdAt', 'quotedPostOwnerId'])
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

    it('indexes one mention per post inline: no postMention doctype', async () => {
      expect(V10.postMention).toBeUndefined()
      expect(V10.post.properties.mentionedUserId).toMatchObject({ contentMediaType: 'application/x.dash.dpp.identifier', refersTo: { type: 'identity' } })
      expect(V10.post.required).not.toContain('mentionedUserId')
      expect(V10.reply.properties.mentionedUserId).toMatchObject({ contentMediaType: 'application/x.dash.dpp.identifier', refersTo: { type: 'identity' } })
      expect(V10.reply.required).not.toContain('mentionedUserId')
      // A descriptor resolves on first use, so each module is read before the next loads.
      const inline: boolean[] = []
      for (const topology of ['v2', 'v9', 'v10']) inline.push((await topologyModule(topology)).mentionsAreInline())
      expect((await topologyModule('v11')).mentionsAreInline()).toBe(true)
      expect(inline).toEqual([false, false, true])
      expect(V9.postMention).toBeDefined()
    })

    it('reads every notification-only source off the current and the previous 3.5-day window of one grid', async () => {
      const halfWeek = { range: 302_400, step: 302_400 }
      const index = (docType: string, name: string) => V10[docType].indices?.find((entry) => entry.name === name) as
        ({ properties: Array<Record<string, string>>; skipIfAbsent?: boolean; timeRange?: Record<string, unknown> } | undefined)
      const keys = (docType: string, name: string) => index(docType, name)?.properties.map((entry) => Object.keys(entry)[0])
      const v10 = await topologyModule('v10')
      const expected = {
        reply: { docType: 'reply', index: 'parentOwnerRecent', recipientField: 'parentOwnerId' },
        quote: { docType: 'post', index: 'quotedPostOwnerRecent', recipientField: 'quotedPostOwnerId' },
      } as const
      for (const [source, shape] of Object.entries(expected) as [keyof typeof expected, (typeof expected)[keyof typeof expected]][]) {
        expect(v10.notificationWindowFor(source), source).toEqual({ ...shape, grid: halfWeek })
        // Non-overlapping windows, each written once, kept for two windows: a week.
        expect(index(shape.docType, shape.index)?.timeRange, source).toEqual({ on: '$createdAt', ...halfWeek, ttl: 604_800 })
        expect(keys(shape.docType, shape.index)?.slice(0, 2), source).toEqual(['$createdAt', shape.recipientField])
      }
      expect(index('post', 'quotedPostOwnerRecent')?.skipIfAbsent).toBe(true)
      // Mentions stay permanent (the Mentions tab keeps its history): the
      // mentioning post's own [mentionedUserId, $createdAt], like tagAndTime.
      // A reply carries one too, on the same shape.
      for (const docType of ['post', 'reply']) {
        const mentions = index(docType, 'mentionedUserAndTime')
        expect(keys(docType, 'mentionedUserAndTime'), docType).toEqual(['mentionedUserId', '$createdAt'])
        expect(mentions?.skipIfAbsent, docType).toBe(true)
        expect(mentions?.timeRange, docType).toBeUndefined()
      }
      expect(v10.mentionDocTypes()).toEqual(['post', 'reply'])
      expect((await topologyModule('v9')).mentionDocTypes()).toEqual(['postMention'])
      // The old permanent notification indexes are gone; follows stay permanent.
      // (Likes are not a windowed source: the node refuses a windowed read of
      // an indexOnly type, so like notifications keep a permanent author index.)
      for (const [docType, removed] of [['reply', 'parentOwnerAndTime'], ['post', 'quotedPostOwnerAndTime']]) {
        expect(index(docType, removed), removed).toBeUndefined()
      }
      expect(keys('follow', 'followers')).toEqual(['followingId', '$createdAt'])
      expect(index('follow', 'followers')?.timeRange).toBeUndefined()
      expect(index('followRequest', 'target')?.timeRange).toBeUndefined()

      for (const topology of ['v2', 'v9']) {
        const m = await topologyModule(topology)
        expect(m.notificationsAreWindowed(), topology).toBe(false)
        expect(m.notificationWindowFor('reply'), topology).toBeNull()
      }
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

  describe('v11 (5.0.0-beta.1)', () => {
    type Json = Record<string, unknown>
    const LIKE_INDEXES = { like: ['byAuthorPostTime', 'byAuthorPost'], likeReply: ['byAuthorReplyTime', 'byAuthorReply'] } as const

    it('is v10 but for the like author indexes, outlivesDelete on the trend windows and the post/reply moderator abilities', () => {
      const v10 = structuredClone(socialContractV10) as unknown as { documentSchemas: Record<string, Json & { indices?: Json[] }> }
      const v11 = structuredClone(socialContractV11) as unknown as typeof v10
      for (const [docType, [before, after]] of Object.entries(LIKE_INDEXES)) {
        const was = v10.documentSchemas[docType].indices?.find((index) => index.name === before)
        const now = v11.documentSchemas[docType].indices?.find((index) => index.name === after)
        expect((was?.properties as Array<Record<string, string>>).map((entry) => Object.keys(entry)[0]).slice(0, 2), docType)
          .toEqual((now?.properties as Array<Record<string, string>>).map((entry) => Object.keys(entry)[0]))
        Object.assign(was ?? {}, { name: after, properties: now?.properties })
      }
      for (const name of ['byTrendPost', 'byTrendHashtagPost']) {
        const index = v11.documentSchemas.like.indices?.find((entry) => entry.name === name)
        expect(index?.outlivesDelete, name).toBe(true)
        delete index?.outlivesDelete
      }
      v10.documentSchemas.likeReply.required = (v10.documentSchemas.likeReply.required as string[]).filter((name) => name !== '$createdAt')
      for (const kind of ['post', 'reply']) v10.documentSchemas[kind].moderatorAbilities = v11.documentSchemas[kind].moderatorAbilities
      // Design M, undone on the v11 side: moderated tombstoning post/reply, moderated references, preallocated trees.
      for (const kind of ['post', 'reply']) {
        const schema = v11.documentSchemas[kind] as Json & { properties: Json; required: string[]; propertyConstraints: Record<string, { anyOf?: unknown[] }> }
        expect([schema.canBeDeleted, schema.documentsMutable, schema.required.at(-1)], kind).toEqual([false, true, '$updatedAt'])
        delete schema.canBeDeleted
        schema.documentsMutable = false
        schema.required = schema.required.slice(0, -1)
        delete schema.properties.deleted
        delete schema.immutable
        delete schema.propertyConstraints.tombstoneIsBlank
        const notEmpty = schema.propertyConstraints.notEmpty
        if (notEmpty?.anyOf) notEmpty.anyOf = notEmpty.anyOf.filter((alternative) => JSON.stringify(alternative) !== '{"present":"deleted"}')
      }
      for (const schema of Object.values(v11.documentSchemas)) {
        for (const property of Object.values((schema.properties ?? {}) as Record<string, { refersTo?: { type: string; documentType?: string } }>)) {
          if (property.refersTo && ['post', 'reply'].includes(property.refersTo.documentType ?? '')) {
            expect(property.refersTo.type).toBe('moderatedDocument')
            property.refersTo.type = 'deletableDocument'
          }
        }
        for (const index of schema.indices ?? []) delete index.preallocated
      }
      expect(v11).toEqual(v10)
    })

    it('tombstones posts and replies (design M): frozen keys, cleared content, a flag that never turns back', async () => {
      const POST_CLEARED = ['content', 'mediaUrl', 'mediaHash', 'mediaFingerprint', 'sensitive', 'encryptedContent', 'keyGeneration', 'nonce', 'embedContractId', 'embedDocType', 'embedId', 'mentionedUserId', 'quotedPostId', 'quotedReplyId', 'quotedPostOwnerId']
      const REPLY_CLEARED = ['content', 'mediaUrl', 'mediaHash', 'mediaFingerprint', 'sensitive', 'encryptedContent', 'keyGeneration', 'nonce', 'mentionedUserId']
      type Immutable = string | { property: string; when: unknown }
      const v11 = await topologyModule('v11')
      for (const [kind, cleared] of [['post', POST_CLEARED], ['reply', REPLY_CLEARED]] as const) {
        const schema = V11[kind] as unknown as { immutable: Immutable[]; properties: Record<string, unknown>; propertyConstraints: Record<string, unknown> }
        const frozen = schema.immutable.filter((entry): entry is string => typeof entry === 'string')
        const { identifiers, scalars } = v11.tombstonePreservationFor(kind)
        // What the tombstone carries is exactly what the contract freezes by name.
        expect([...identifiers, ...scalars].sort(), kind).toEqual([...frozen].sort())
        expect(schema.immutable).toContainEqual({ property: 'deleted', when: { present: '$old.deleted' } })
        const conditional = schema.immutable.filter((entry): entry is { property: string; when: unknown } => typeof entry !== 'string' && entry.property !== 'deleted')
        expect(conditional.map((entry) => entry.property).sort(), kind).toEqual([...cleared].sort())
        for (const entry of conditional) expect(entry.when).toEqual({ absent: 'deleted' })
        // Every property is either frozen, cleared by the tombstone, or the flag itself.
        expect(Object.keys(schema.properties).sort(), kind).toEqual([...frozen, ...cleared, 'deleted'].sort())
        expect(JSON.stringify(schema.propertyConstraints.tombstoneIsBlank)).toBe(JSON.stringify({ anyOf: [{ absent: 'deleted' }, { allOf: [{ equal: ['deleted', 1] }, ...cleared.map((p) => ({ absent: p }))] }] }))
      }
      const flags = async (topology: string) => {
        const m = await topologyModule(topology)
        return [m.deletesAreTombstones(), m.tombstoneKeepsEmptyContent(), m.likeTreesArePreallocated(), m.authorDeletesLeaveHoles(), m.repliesOutliveTheirParent(), m.tombstonesAreHidden()]
      }
      // A moderator's removal still leaves a hole on v11 (repliesOutliveTheirParent); an author's never does.
      expect(await flags('v2')).toEqual([false, false, false, false, false, false])
      expect(await flags('v9')).toEqual([true, true, false, false, false, false])
      expect(await flags('v10')).toEqual([false, false, false, true, true, false])
      expect(await flags('v11')).toEqual([true, false, true, false, true, true])
      // The preallocated trees: every untimed like index (the windows cannot be).
      for (const docType of ['like', 'likeReply']) {
        for (const index of V11[docType].indices ?? []) {
          expect(index.preallocated === true, `${docType}.${index.name}`).toBe(!(index as { timeRange?: unknown }).timeRange)
        }
      }
    })

    it('keeps every v10 surface but the like shape, and v2, v9 and v10 behave as before', async () => {
      const read = async (topology: string) => {
        const m = await topologyModule(topology)
        return {
          linkage: m.replyLinkage(),
          kinds: (['post', 'reply'] as const).map((kind) => [m.likeIndexFor(kind), m.repostIndexFor(kind), m.bookmarkIndexFor(kind), m.quoteFieldFor(kind), m.replyCountFieldFor(kind)]),
          rankings: (['posts', 'hashtags', 'creators'] as const).map((axis) => m.windowedRankingFor(axis)),
          windows: (['reply', 'quote'] as const).map((source) => m.notificationWindowFor(source)),
          flags: [m.isV10(), m.repostsAreQuotes(), m.mentionsAreInline(), m.notificationsAreWindowed(), m.reportsAreResolved(), m.yappIsLocked(), m.likesAreIndexOnly()],
          isV11: m.isV11(),
          settled: (['post', 'reply', 'report'] as const).map((docType) => [m.settledDeletionFor(docType), m.removalKeptFieldsFor(docType), m.moderatorDeleteWindowSeconds(docType)]),
          elected: m.electedModeration(),
        }
      }
      const [v2, v9, v10, v11] = [await read('v2'), await read('v9'), await read('v10'), await read('v11')]
      expect({ ...v11, isV11: false, settled: v10.settled }).toEqual(v10)
      expect([v2.isV11, v9.isV11, v10.isV11, v11.isV11]).toEqual([false, false, false, true])
      for (const before of [v2, v9, v10]) expect(before.settled.flat(2).every((value) => value === null || (Array.isArray(value) && value.length === 0))).toBe(true)
      expect(v11.settled).toEqual([
        [{ windowSeconds: 604_800, leaderRequired: true, approvals: 3 }, ['hashtag', '$createdAt'], 604_800],
        [{ windowSeconds: 604_800, leaderRequired: true, approvals: 3 }, ['rootPostId', '$createdAt'], 604_800],
        [null, [], null],
      ])
    })

    it('lets the elected team delete what it may approve: deleteDocuments on post and reply, and seats for three approvals', async () => {
      const v11 = await topologyModule('v11')
      const elected = v11.electedModeration()
      for (const docType of ['post', 'reply']) expect(elected?.moderatedDocumentTypes[docType], docType).toContain('deleteDocuments')
      // The leader, the elected members (up to 15) and the additions: a rule of three always fits.
      expect(1 + (elected?.maxAddedModerators ?? 0)).toBeGreaterThanOrEqual(3)
      // A replaceable type measures the window from `$updatedAt`, which it must require
      // (a tombstone, its only replace, opens the window again).
      for (const docType of ['post', 'reply']) {
        expect(V11[docType].documentsMutable, docType).toBe(true)
        expect(V11[docType].required, docType).toEqual(expect.arrayContaining(['$createdAt', '$updatedAt']))
      }
    })
  })

  describe('v12 (5.0.0-beta.2)', () => {
    type Json = Record<string, unknown>
    const COUNTERS = { like: [['byHashtagPost', 'byPost'], ['byAuthorPost', 'byPost']], likeReply: [['byAuthorReply', 'byReply']] } as const

    it('is v11 but for the counter author and hashtag indexes and retractedWhen on post and reply', () => {
      const v11 = structuredClone(socialContractV11) as unknown as { documentSchemas: Record<string, Json & { indices?: Json[] }> }
      const v12 = structuredClone(socialContractV12) as unknown as typeof v11
      for (const [docType, counters] of Object.entries(COUNTERS)) {
        for (const [name, source] of counters) {
          const index = v12.documentSchemas[docType].indices?.find((entry) => entry.name === name)
          expect([index?.summableOffCountIndex, index?.rangeSummable, index?.rangeCountable, index?.preallocated], `${docType}.${name}`).toEqual([source, true, true, true])
          // Undo: back to an entry per like, keyed by the liker.
          delete index?.summableOffCountIndex
          delete index?.rangeSummable
          if (index) index.terminal = '$ownerId'
        }
      }
      // v11's byAuthorReply was an unranked, countable-less list of likers.
      const authorReply = v12.documentSchemas.likeReply.indices?.find((entry) => entry.name === 'byAuthorReply')
      delete authorReply?.rangeCountable
      for (const kind of ['post', 'reply']) {
        expect(v12.documentSchemas[kind].retractedWhen, kind).toEqual({ present: 'deleted' })
        delete v12.documentSchemas[kind].retractedWhen
      }
      // Index keys are compared by content, not by the order the JSON lists them.
      const normalize = (contract: typeof v11) => JSON.parse(JSON.stringify(contract, (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value as Json).sort(([a], [b]) => a.localeCompare(b)))
          : value)) as unknown
      expect(normalize(v12)).toEqual(normalize(v11))
    })

    it('keeps every v11 surface and rule but the counter flag and the barred tombstone, which no earlier topology has', async () => {
      const read = async (topology: string) => {
        const m = await topologyModule(topology)
        return {
          linkage: m.replyLinkage(),
          kinds: (['post', 'reply'] as const).map((kind) => [m.likeIndexFor(kind), m.repostIndexFor(kind), m.bookmarkIndexFor(kind), m.quoteFieldFor(kind), m.replyCountFieldFor(kind), m.tombstonePreservationFor(kind)]),
          shapes: (['post', 'reply'] as const).map((kind) => m.indexOnlyLikeShapeFor(kind)),
          rankings: (['posts', 'hashtags', 'creators'] as const).map((axis) => m.windowedRankingFor(axis)),
          windows: (['reply', 'quote'] as const).map((source) => m.notificationWindowFor(source)),
          flags: [m.isV10(), m.isV11(), m.repostsAreQuotes(), m.mentionsAreInline(), m.notificationsAreWindowed(), m.reportsAreResolved(), m.yappIsLocked(), m.likesAreIndexOnly(),
            m.deletesAreTombstones(), m.tombstoneKeepsEmptyContent(), m.likeTreesArePreallocated(), m.authorDeletesLeaveHoles(), m.repliesOutliveTheirParent(), m.tombstonesAreHidden(),
            m.likeNotificationsPinTarget(), m.likeNotificationsAreTimeless(), m.prefixRankingsAvailable()],
          barredTombstone: m.barredAuthorsCanTombstone(),
          settled: (['post', 'reply', 'report'] as const).map((docType) => [m.settledDeletionFor(docType), m.removalKeptFieldsFor(docType), m.moderatorDeleteWindowSeconds(docType)]),
          elected: m.electedModeration(),
        }
      }
      const [v2, v9, v10, v11, v12] = [await read('v2'), await read('v9'), await read('v10'), await read('v11'), await read('v12')]
      expect(v12.shapes.map((shape) => shape?.authorIndexIsCounter)).toEqual([true, true])
      expect({
        ...v12,
        shapes: v12.shapes.map((shape) => shape && { ...shape, authorIndexIsCounter: false }),
        barredTombstone: false,
      }).toEqual(v11)
      expect([v2, v9, v10, v11, v12].map((m) => m.barredTombstone)).toEqual([false, false, false, false, true])
      for (const before of [v9, v10, v11]) expect(before.shapes.map((shape) => shape?.authorIndexIsCounter), 'no counter before v12').toEqual([false, false])
    })
  })

  describe('v13 (the mainnet candidate)', () => {
    it('binds a reply to its thread: rootOwnerId required, frozen, preserved by the tombstone', async () => {
      const v13 = await topologyModule('v13')
      expect(V13.reply.required).toEqual(expect.arrayContaining(['rootPostId', 'rootOwnerId', 'parentOwnerId']))
      expect(V13.reply.properties.rootPostId.refersTo?.where).toEqual({ $ownerId: 'rootOwnerId' })
      expect(V13.reply.properties.replyToReplyId.refersTo?.where).toEqual({ $ownerId: 'parentOwnerId', rootPostId: 'rootPostId' })
      expect(V13.reply.propertyConstraints?.parentIsRoot).toEqual({ ifThen: [{ absent: 'replyToReplyId' }, { equal: ['parentOwnerId', 'rootOwnerId'] }] })
      // The tombstone carries exactly the unconditionally frozen linkage over.
      const frozen = (V13.reply.immutable as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      const { identifiers, scalars } = v13.tombstonePreservationFor('reply')
      expect([...identifiers, ...scalars].sort()).toEqual([...frozen].sort())
      expect(v13.repliesNameRootOwner()).toBe(true)
      for (const before of ['v2', 'v9', 'v10', 'v11', 'v12']) expect((await topologyModule(before)).repliesNameRootOwner(), before).toBe(false)
    })

    it('refuses reply owners that parentIsRoot or the root reference would, before signing', async () => {
      const v13 = await topologyModule('v13')
      expect(v13.replyOwnersProblem({ parentOwnerId: 'A', rootOwnerId: 'A' })).toBeNull()
      expect(v13.replyOwnersProblem({ replyToReplyId: 'R', parentOwnerId: 'B', rootOwnerId: 'A' })).toBeNull()
      expect(v13.replyOwnersProblem({ parentOwnerId: 'B', rootOwnerId: 'A' })).toMatch(/thread's post/)
      expect(v13.replyOwnersProblem({ parentOwnerId: 'A' })).toMatch(/rootOwnerId/)
      // Before v13 nothing binds them, and nothing is written.
      expect((await topologyModule('v12')).replyOwnersProblem({ parentOwnerId: 'B', rootOwnerId: 'A' })).toBeNull()
    })

    it('likes a reply by its id alone: no replyAuthor, no author counter', async () => {
      const v13 = await topologyModule('v13')
      expect(V13.likeReply.required).toEqual(['replyId'])
      expect(v13.likeIndexFor('reply')).toEqual({ docType: 'likeReply', field: 'replyId', ownerFirst: false, ownerField: null, ownerIsTerminal: true })
      expect(v13.indexOnlyLikeShapeFor('reply')).toMatchObject({ authorField: null, hashtagField: null, deleteNamesCreatedAt: false })
      // Post likes are v12's, counters included.
      const v12 = await topologyModule('v12')
      expect(v13.indexOnlyLikeShapeFor('post')).toEqual(v12.indexOnlyLikeShapeFor('post'))
      expect(v13.likeIndexFor('post')).toEqual(v12.likeIndexFor('post'))
    })

    it('reads post timelines with live == true pinned first, where the contract keys ownerAndTime on it', async () => {
      const index = V13.post.indices?.find((entry) => entry.name === 'ownerAndTime')
      expect(index?.properties.map((entry) => Object.keys(entry)[0])).toEqual(['live', '$ownerId', '$createdAt'])
      expect([index?.skipIfAbsent, index?.rangeCountable, index?.rankedCountable]).toEqual([true, true, { at: '$ownerId' }])
      const v13 = await topologyModule('v13')
      expect([v13.postsCarryLiveMarker(), v13.postOwnerIndexPrefix(), v13.postOwnerIndexOrderPrefix()]).toEqual([true, [['live', '==', true]], [['live', 'asc']]])
      for (const before of ['v2', 'v9', 'v10', 'v11', 'v12']) {
        const m = await topologyModule(before)
        expect([m.postsCarryLiveMarker(), m.postOwnerIndexPrefix(), m.postOwnerIndexOrderPrefix()], before).toEqual([false, [], []])
      }
    })

    it('carries up to four media items in three arrays', async () => {
      const v13 = await topologyModule('v13')
      for (const kind of ['post', 'reply']) {
        expect(V13[kind].properties.mediaUrls.maxItems, kind).toBe(4)
        expect(V13[kind].properties.mediaDigests.maxItems, kind).toBe(160)
        expect(V13[kind].properties.mediaKinds.maxItems, kind).toBe(4)
        expect(V13[kind].properties.mediaUrl, kind).toBeUndefined()
      }
      expect([v13.mediaIsArrays(), v13.mediaItemLimit(), v13.mediaCarriesHashes()]).toEqual([true, 4, true])
      const v12 = await topologyModule('v12')
      expect([v12.mediaIsArrays(), v12.mediaItemLimit()]).toEqual([false, 1])
    })

    it('takes profile reports and moderators\' boxes, reason 9, through target-first indexes', async () => {
      const v13 = await topologyModule('v13')
      expect(v13.reportShape()).toEqual({ maxReason: 9, profiles: true, boxMaxBytes: 5_120, targetFirst: true })
      const names = V13.report.indices?.map((index) => index.name)
      expect(names).toEqual(['byPost', 'byReply', 'byTarget', 'byStatus', 'byModerator'])
      expect(v13.declaredActionFee('report', 'create')).toEqual({ owner: 0n, moderators: 50_000_000n, pricing: 'feeMultiplier' })
      const v12 = await topologyModule('v12')
      expect(v12.reportShape()).toEqual({ maxReason: 8, profiles: false, boxMaxBytes: null, targetFirst: false })
      expect(v12.declaredActionFee('report', 'create')).toBeNull()
    })

    it('keeps block types in the blocks contract, and the social contract free of them', async () => {
      for (const docType of ['block', 'blockFilter', 'blockFollow']) expect(V13[docType], docType).toBeUndefined()
      expect(Object.keys(BLOCKS).sort()).toEqual(['block', 'blockFilter', 'blockFollow'])
      vi.stubEnv('NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID', '')
      expect((await topologyModule('v13')).blocksContractId()).toBeNull()
      vi.stubEnv('NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID', 'BLOCKS')
      const v13 = await topologyModule('v13')
      expect(v13.blocksContractId()).toBe('BLOCKS')
      expect(v13.ownerDistinctProperties('block')).toEqual(['blockedId'])
      expect(v13.ownerDistinctProperties('blockFollow')).toEqual(['followedBlockers'])
      expect((await topologyModule('v12')).blocksContractId()).not.toBe('BLOCKS')
      vi.unstubAllEnvs()
    })

    it('declares mainnet election windows and a contestable seat', async () => {
      const elected = (await topologyModule('v13')).electedModeration()
      expect(elected).toMatchObject({
        joinWindowSeconds: 604_800,
        voteWindowSeconds: 259_200,
        seatContestable: true,
        challengeCoolDownSeconds: 2_592_000,
        maxAddedModerators: 10,
        interim: 'contractOwner',
        ownerProtected: true,
      })
    })

    it('keeps every v12 surface and rule but those', async () => {
      const read = async (topology: string) => {
        const m = await topologyModule(topology)
        return {
          linkage: m.replyLinkage(),
          post: [m.likeIndexFor('post'), m.repostIndexFor('post'), m.bookmarkIndexFor('post'), m.quoteFieldFor('post'), m.replyCountFieldFor('post'), m.tombstonePreservationFor('post')],
          rankings: (['posts', 'hashtags', 'creators'] as const).map((axis) => m.windowedRankingFor(axis)),
          windows: (['reply', 'quote'] as const).map((source) => m.notificationWindowFor(source)),
          flags: [m.isV10(), m.isV11(), m.repostsAreQuotes(), m.mentionsAreInline(), m.notificationsAreWindowed(), m.reportsAreResolved(), m.yappIsLocked(), m.likesAreIndexOnly(),
            m.deletesAreTombstones(), m.tombstoneKeepsEmptyContent(), m.likeTreesArePreallocated(), m.authorDeletesLeaveHoles(), m.repliesOutliveTheirParent(), m.tombstonesAreHidden(),
            m.likeNotificationsPinTarget(), m.likeNotificationsAreTimeless(), m.prefixRankingsAvailable(), m.barredAuthorsCanTombstone(), m.contractTakesReports()],
          settled: (['post', 'reply', 'report'] as const).map((docType) => [m.settledDeletionFor(docType), m.removalKeptFieldsFor(docType), m.moderatorDeleteWindowSeconds(docType)]),
        }
      }
      expect(await read('v13')).toEqual(await read('v12'))
    })
  })

  describe('v14 (5.0.0-beta.3)', () => {
    it('stores no owner on a reply: no parentOwnerId, rootOwnerId or parentIsRoot, and a tombstone keeps root and parent', async () => {
      for (const gone of ['parentOwnerId', 'rootOwnerId']) expect(V14.reply.properties[gone], gone).toBeUndefined()
      expect(V14.reply.required).toEqual(['$createdAt', '$updatedAt', 'rootPostId'])
      expect(V14.reply.propertyConstraints?.parentIsRoot).toBeUndefined()
      expect(V14.reply.properties.rootPostId.refersTo).toEqual({ type: 'moderatedDocument', documentType: 'post' })
      // A nested reply still stays in its parent's thread.
      expect(V14.reply.properties.replyToReplyId.refersTo?.where).toEqual({ rootPostId: 'rootPostId' })
      // The derived windows read through these two, so both are frozen without a condition.
      const frozen = (V14.reply.immutable as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      expect(frozen).toEqual(['rootPostId', 'replyToReplyId'])
      const v14 = await topologyModule('v14')
      const { identifiers, scalars } = v14.tombstonePreservationFor('reply')
      expect([...identifiers, ...scalars].sort()).toEqual([...frozen].sort())
      expect([v14.replyOwnersAreDerived(), v14.repliesNameRootOwner()]).toEqual([true, false])
      // Nothing to name, so nothing a client could get wrong.
      expect(v14.replyOwnersProblem({ parentOwnerId: 'B' })).toBeNull()
      for (const before of ['v2', 'v9', 'v10', 'v11', 'v12', 'v13']) expect((await topologyModule(before)).replyOwnersAreDerived(), before).toBe(false)
    })

    it('reads replies to me off two derived windows on the v13 grid: parent replies and whole threads', async () => {
      const index = (name: string) => V14.reply.indices?.find((entry) => entry.name === name)
      const keys = (name: string) => index(name)?.properties.map((entry) => Object.keys(entry)[0])
      expect(keys('rootOwnerRecent')).toEqual(['$createdAt', 'rootPostId.$ownerId'])
      expect(keys('parentOwnerRecent')).toEqual(['$createdAt', 'replyToReplyId.$ownerId'])
      // A top-level reply has no parent reply: it is left out of parentOwnerRecent, never filed under nobody.
      expect(index('parentOwnerRecent')?.skipIfAbsent).toEqual(['replyToReplyId.$ownerId'])
      expect(index('rootOwnerRecent')?.skipIfAbsent).toBeUndefined()
      const v13Window = V13.reply.indices?.find((entry) => entry.name === 'parentOwnerRecent')?.timeRange
      for (const name of ['rootOwnerRecent', 'parentOwnerRecent']) expect(index(name)?.timeRange, name).toEqual(v13Window)

      const halfWeek = { range: 302_400, step: 302_400 }
      const v14 = await topologyModule('v14')
      expect(v14.notificationWindowFor('reply')).toEqual({ docType: 'reply', index: 'parentOwnerRecent', recipientField: 'replyToReplyId.$ownerId', grid: halfWeek })
      expect(v14.notificationWindowFor('threadReply')).toEqual({ docType: 'reply', index: 'rootOwnerRecent', recipientField: 'rootPostId.$ownerId', grid: halfWeek })
      const v13 = await topologyModule('v13')
      expect(v13.notificationWindowFor('reply')).toEqual({ docType: 'reply', index: 'parentOwnerRecent', recipientField: 'parentOwnerId', grid: halfWeek })
      expect(v13.notificationWindowFor('threadReply')).toBeNull()
      expect((await topologyModule('v2')).notificationWindowFor('threadReply')).toBeNull()
    })

    it('starts YAPP unpaused (beta.3 refuses payment in a paused token), so it pays token costs; it is still never bought or sent', async () => {
      const [v13Token, v14Token] = [socialContractV13.tokens['0'], socialContractV14.tokens['0']]
      expect([v13Token.startAsPaused, v14Token.startAsPaused]).toEqual([true, false])
      expect({ ...v14Token, startAsPaused: true }).toEqual(v13Token)
      // Nobody can ever pause it, or price it.
      expect(v14Token.emergencyActionRules.authorizedToMakeChange.$type).toBe('noOne')
      expect(v14Token.distributionRules.changeDirectPurchasePricingRules.authorizedToMakeChange.$type).toBe('noOne')
      const v14 = await topologyModule('v14')
      expect([v14.yappIsPausedForGood(), v14.yappIsLocked()]).toEqual([false, true])
      const v13 = await topologyModule('v13')
      expect([v13.yappIsPausedForGood(), v13.yappIsLocked()]).toEqual([true, true])
      const sponsored = { optional: true, gasFeesPaidBy: 2 }
      for (const [docType, amount] of [['post', 10], ['reply', 3], ['like', 1], ['likeReply', 1]] as const) {
        expect(v14.tokenCostFor(docType), docType).toEqual({ amount, ...sponsored })
      }
      expect(v14.starterGrantAmount()).toBe(100n)
    })

    it('lets a reporter withdraw a report only while no moderator has resolved it', async () => {
      expect(V14.report.deleteConstraints).toEqual({ pending: { absent: 'status' } })
      expect(V13.report.deleteConstraints).toBeUndefined()
      expect((await topologyModule('v14')).reportsWithdrawOnlyWhilePending()).toBe(true)
      for (const before of ['v2', 'v9', 'v10', 'v13']) expect((await topologyModule(before)).reportsWithdrawOnlyWhilePending(), before).toBe(false)
    })

    it('keeps the v13 rule names, rewritten with countPresent', () => {
      const names = (schemas: Schemas, docType: string) => Object.keys(schemas[docType].propertyConstraints ?? {}).sort()
      expect(names(V14, 'post')).toEqual(names(V13, 'post'))
      expect(names(V14, 'report')).toEqual(names(V13, 'report'))
      expect(names(V14, 'reply')).toEqual(names(V13, 'reply').filter((rule) => rule !== 'parentIsRoot'))
      expect(V14.report.propertyConstraints?.oneTarget).toEqual({ equal: [{ countPresent: ['postId', 'replyId', 'about'] }, 1] })
      for (const docType of ['post', 'reply']) {
        expect(V14[docType].propertyConstraints?.private, docType).toEqual({ in: [{ countPresent: ['encryptedContent', 'keyGeneration', 'nonce'] }, [0, 3]] })
      }
    })

    it('keeps every v13 surface and rule but those', async () => {
      const read = async (topology: string) => {
        const m = await topologyModule(topology)
        return {
          linkage: m.replyLinkage(),
          post: [m.likeIndexFor('post'), m.repostIndexFor('post'), m.bookmarkIndexFor('post'), m.quoteFieldFor('post'), m.replyCountFieldFor('post'), m.tombstonePreservationFor('post')],
          reply: [m.likeIndexFor('reply'), m.indexOnlyLikeShapeFor('reply'), m.quoteFieldFor('reply'), m.replyCountFieldFor('reply')],
          rankings: (['posts', 'hashtags', 'creators'] as const).map((axis) => m.windowedRankingFor(axis)),
          quotes: m.notificationWindowFor('quote'),
          flags: [m.isV10(), m.isV11(), m.repostsAreQuotes(), m.mentionsAreInline(), m.notificationsAreWindowed(), m.reportsAreResolved(), m.likesAreIndexOnly(),
            m.deletesAreTombstones(), m.tombstoneKeepsEmptyContent(), m.likeTreesArePreallocated(), m.authorDeletesLeaveHoles(), m.repliesOutliveTheirParent(), m.tombstonesAreHidden(),
            m.likeNotificationsPinTarget(), m.likeNotificationsAreTimeless(), m.prefixRankingsAvailable(), m.barredAuthorsCanTombstone(), m.contractTakesReports(),
            m.postsCarryLiveMarker(), m.mediaIsArrays(), m.mediaItemLimit(), m.profilesAreReportable()],
          report: [m.reportShape(), m.declaredActionFee('report', 'create')],
          fees: (['post', 'reply'] as const).map((docType) => m.declaredActionFee(docType, 'create')),
          elected: m.electedModeration(),
          settled: (['post', 'reply', 'report'] as const).map((docType) => [m.settledDeletionFor(docType), m.removalKeptFieldsFor(docType), m.moderatorDeleteWindowSeconds(docType)]),
        }
      }
      expect(await read('v14')).toEqual(await read('v13'))
    })
  })

  describe('v15 (5.0.0-beta.4)', () => {
    /** A contract's JSON with every property type shorthand written out. */
    const longForm = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(longForm)
      if (!value || typeof value !== 'object') return value
      const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, longForm(nested)] as const)
      const object = Object.fromEntries(entries) as Record<string, unknown>
      if (object.type !== 'identifier' && object.type !== 'bytes') return object
      const { type, size, ...rest } = object
      const bytes = type === 'identifier' ? 32 : size
      return { ...rest, type: 'array', byteArray: true, minItems: bytes, maxItems: bytes, ...(type === 'identifier' ? { contentMediaType: 'application/x.dash.dpp.identifier' } : {}) }
    }
    type Cost = { amount: number; effect?: number }
    const costOf = (schema: Schemas[string]) => schema.tokenCost?.create as Cost | undefined
    const withoutEffect = (schemas: Schemas) => Object.fromEntries(Object.entries(schemas).map(([docType, schema]) => {
      const cost = costOf(schema)
      if (!cost) return [docType, schema]
      const create: Cost = { ...cost }
      delete create.effect
      return [docType, { ...schema, tokenCost: { create } }]
    }))

    /** v15 with its mentions array written back as v14's single `mentionedUserId` (the array is pinned on its own below). */
    const withSingleMention = (schemas: Schemas): Schemas => {
      const single = JSON.parse(JSON.stringify(schemas).replaceAll('"mentionedUserIds"', '"mentionedUserId"')) as Schemas
      for (const docType of ['post', 'reply']) {
        const { position } = single[docType].properties.mentionedUserId as { position: number }
        single[docType].properties.mentionedUserId = { type: 'identifier', refersTo: { type: 'identity' }, position } as Schemas[string]['properties'][string]
        const index = single[docType].indices?.find((entry) => entry.name === 'mentionedUserAndTime')
        if (index) index.skipIfAbsent = true
      }
      return single
    }

    /** v15 without the report rule its 5.0.0-beta.5 re-cut added (pinned on its own below). */
    const withoutStaysResolved = (schemas: Schemas): Schemas => {
      const copy = JSON.parse(JSON.stringify(schemas)) as Schemas
      delete (copy.report.propertyConstraints as Record<string, unknown>).staysResolved
      return copy
    }

    it('is v14 written with shorthands, every YAPP cost burning (effect 1)', () => {
      const costs = Object.values(V15).map(costOf).filter((cost): cost is Cost => cost !== undefined)
      expect(costs.map((cost) => cost.effect)).toEqual([1, 1, 1, 1])
      expect(JSON.stringify(V15)).toMatch(/"type":"identifier"/)
      expect(longForm(withoutEffect(withSingleMention(withoutStaysResolved(V15))))).toEqual(longForm(V14))
    })

    it('keeps a resolved report resolved: a moderator may change its status, never remove it', () => {
      expect((V15.report.propertyConstraints as Record<string, unknown>).staysResolved)
        .toEqual({ ifThen: [{ present: '$old.status' }, { present: 'status' }] })
    })

    it('names up to 8 distinct mentions per post or reply, indexed per element, cleared by the tombstone', async () => {
      for (const docType of ['post', 'reply']) {
        const schema = V15[docType]
        expect(schema.properties.mentionedUserIds, docType).toEqual({
          type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'identifier', refersTo: { type: 'identity' } }, position: docType === 'post' ? 15 : 10,
        })
        expect(schema.properties.mentionedUserId, docType).toBeUndefined()
        // An array index always skips an empty list; skipIfAbsent on the array alone is refused (10231).
        expect(schema.indices?.find((entry) => entry.name === 'mentionedUserAndTime'), docType)
          .toEqual({ name: 'mentionedUserAndTime', properties: [{ mentionedUserIds: 'asc' }, { $createdAt: 'asc' }] })
        expect(schema.immutable, docType).toContainEqual({ property: 'mentionedUserIds', when: { absent: 'deleted' } })
        expect(JSON.stringify(schema.propertyConstraints?.blankTombstone), docType).toContain('"mentionedUserIds"')
        expect(JSON.stringify(schema.propertyConstraints?.notEmpty ?? {}), docType).not.toContain('mentionedUserIds')
      }

      const shapes: Record<string, unknown> = {}
      for (const topology of ['v2', 'v9', 'v10', 'v14', 'v15']) shapes[topology] = (await topologyModule(topology)).inlineMentions()
      expect(shapes).toEqual({
        v2: null,
        v9: null,
        v10: { field: 'mentionedUserId', max: 1, isArray: false },
        v14: { field: 'mentionedUserId', max: 1, isArray: false },
        v15: { field: 'mentionedUserIds', max: 8, isArray: true },
      })
      const v15 = await topologyModule('v15')
      expect([v15.mentionsAreInline(), v15.mentionDocTypes()]).toEqual([true, ['post', 'reply']])
      // The tombstone keeps nothing of the mentions (blankTombstone above).
      expect([...v15.tombstonePreservationFor('post').identifiers, ...v15.tombstonePreservationFor('reply').identifiers]).not.toContain('mentionedUserIds')
    })

    it('makes YAPP non-transferable and starts it with no supply; every other token rule is v14\'s', async () => {
      const [v14Token, v15Token] = [socialContractV14.tokens['0'], socialContractV15.tokens['0']]
      expect([v15Token.$formatVersion, v15Token.transferable, v15Token.baseSupply]).toEqual(['1', false, 0])
      expect({ ...v15Token, transferable: undefined, $formatVersion: v14Token.$formatVersion, baseSupply: v14Token.baseSupply }).toEqual(v14Token)

      const v15 = await topologyModule('v15')
      expect([v15.yappIsTransferable(), v15.yappIsLocked(), v15.yappIsPausedForGood()]).toEqual([false, true, false])
      for (const topology of ['v2', 'v9', 'v10', 'v13', 'v14']) expect((await topologyModule(topology)).yappIsTransferable(), topology).toBe(true)
      const sponsored = { optional: true, gasFeesPaidBy: 2 }
      for (const [docType, amount] of [['post', 10], ['reply', 3], ['like', 1], ['likeReply', 1]] as const) {
        expect(v15.tokenCostFor(docType), docType).toEqual({ amount, ...sponsored })
      }
      expect(v15.starterGrantAmount()).toBe(100n)
    })

    it('keeps every v14 surface', async () => {
      const read = async (topology: string) => {
        const m = await topologyModule(topology)
        return {
          descriptor: { ...m.topologyDescriptor(), topology: null },
          windows: (['reply', 'quote', 'threadReply'] as const).map((source) => m.notificationWindowFor(source)),
          flags: [m.replyOwnersAreDerived(), m.repliesNameRootOwner(), m.reportsWithdrawOnlyWhilePending(), m.reportShape(), m.electedModeration(), m.blocksContractId()],
        }
      }
      expect(await read('v15')).toEqual(await read('v14'))
    })
  })

  describe('v16 (5.0.0-beta.6)', () => {
    const tagList = { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9_]{1,61}$', maxLength: 61 } }
    const indexOf = (schemas: Schemas, docType: string, name: string) => schemas[docType].indices?.find((entry) => entry.name === name)

    /** v16 with its tag list written back as v15's single `hashtag`, and the tag indexes' `skipIfAbsent` restored. */
    const withSingleTag = (schemas: Schemas): Schemas => {
      const single = JSON.parse(JSON.stringify(schemas).replaceAll('"tags"', '"hashtag"')) as Schemas
      for (const docType of ['post', 'like']) {
        const { position } = single[docType].properties.hashtag as { position: number }
        single[docType].properties.hashtag = { type: 'string', pattern: '^[a-z0-9_]{1,61}$', maxLength: 61, position } as Schemas[string]['properties'][string]
      }
      for (const [docType, name] of [['post', 'tagAndTime'], ['like', 'byHashtagPost'], ['like', 'byTrendHashtagPost']] as const) {
        const index = indexOf(single, docType, name)
        if (index) index.skipIfAbsent = true
      }
      return single
    }

    it('is v15 with the post\'s tag a list of up to 4 and the like repeating it', () => {
      expect(withSingleTag(V16)).toEqual(V15)
      for (const docType of ['post', 'like']) {
        expect(V16[docType].properties.tags, docType).toEqual({ ...tagList, position: docType === 'post' ? 12 : 1 })
        expect(V16[docType].properties.hashtag, docType).toBeUndefined()
      }
      expect(V16.like.properties.postId.refersTo?.where).toEqual({ tags: 'tags', $ownerId: 'postAuthor' })
      expect(V16.post.immutable).toContain('tags')
      expect((V16.post.moderatorAbilities as { deleteKeepsFields?: string[] }).deleteKeepsFields).toEqual(['tags', '$createdAt'])
    })

    it('indexes the tags per element, with no skipIfAbsent (an empty list enters no index), the like counter preallocated', () => {
      expect(indexOf(V16, 'post', 'tagAndTime')).toEqual({ name: 'tagAndTime', properties: [{ tags: 'asc' }, { $createdAt: 'asc' }] })
      expect(indexOf(V16, 'like', 'byHashtagPost')).toEqual({
        name: 'byHashtagPost', properties: [{ tags: 'asc' }, { postId: 'asc' }], summableOffCountIndex: 'byPost',
        rangeCountable: true, rangeSummable: true, rankedCountable: { at: ['tags', 'postId'] }, preallocated: true,
      })
      expect(indexOf(V16, 'like', 'byTrendHashtagPost')?.properties).toEqual([{ $createdAt: 'asc' }, { tags: 'asc' }, { postId: 'asc' }])
      expect(indexOf(V16, 'like', 'byTrendHashtagPost')?.skipIfAbsent).toBeUndefined()
    })

    it('reads and writes the tag list where v15 read one tag', async () => {
      const shapes: Record<string, unknown> = {}
      for (const topology of ['v2', 'v9', 'v15', 'v16']) shapes[topology] = (await topologyModule(topology)).inlineTags()
      expect(shapes).toEqual({
        v2: null,
        v9: { field: 'hashtag', max: 1, isArray: false },
        v15: { field: 'hashtag', max: 1, isArray: false },
        v16: { field: 'tags', max: 4, isArray: true },
      })

      const v16 = await topologyModule('v16')
      expect(v16.tagFieldsFor(['dash', 'news'])).toEqual({ tags: ['dash', 'news'] })
      expect(v16.tagFieldsFor([])).toEqual({})
      expect(v16.inlinePostTags({ tags: ['dash', 'news'] })).toEqual(['dash', 'news'])
      expect(v16.inlinePostTags({}, {})).toEqual([])
      expect(v16.indexOnlyLikeShapeFor('post')?.hashtagField).toBe('tags')
      expect(v16.tombstonePreservationFor('post')).toEqual({ identifiers: [], scalars: ['tags'] })

      const v15 = await topologyModule('v15')
      expect(v15.tagFieldsFor(['dash', 'news'])).toEqual({ hashtag: 'dash' })
      expect(v15.inlinePostTags({ hashtag: 'dash' })).toEqual(['dash'])
      // An already-built Post passed back through a transform carries `tags`.
      expect(v15.inlinePostTags({ tags: ['dash'] })).toEqual(['dash'])
      expect(v15.inlinePostTags({ hashtag: 7 })).toBeUndefined()

      const v2 = await topologyModule('v2')
      expect([v2.tagFieldsFor(['dash']), v2.inlinePostTags({ hashtag: 'dash' })]).toEqual([{}, undefined])
    })

    it('keeps every v15 surface but the tag field', async () => {
      const read = async (topology: string) => {
        const m = await topologyModule(topology)
        const descriptor = m.topologyDescriptor()
        const postLike = descriptor.interactions.post.indexOnlyLike
        return {
          descriptor: {
            ...descriptor,
            topology: null,
            tombstonePreserves: { ...descriptor.tombstonePreserves, post: null },
            interactions: { ...descriptor.interactions, post: { ...descriptor.interactions.post, indexOnlyLike: postLike && { ...postLike, hashtagField: null } } },
          },
          windows: (['reply', 'quote', 'threadReply'] as const).map((source) => m.notificationWindowFor(source)),
          rankings: (['posts', 'hashtags', 'creators'] as const).map((axis) => m.windowedRankingFor(axis)),
          flags: [m.replyOwnersAreDerived(), m.reportsWithdrawOnlyWhilePending(), m.reportShape(), m.electedModeration(), m.blocksContractId(), m.inlineMentions(), m.yappIsTransferable()],
        }
      }
      expect(await read('v16')).toEqual(await read('v15'))
    })
  })

  describe('v17 (the testnet production cut)', () => {
    const indexOf = (schemas: Schemas, docType: string, name: string) => schemas[docType].indices?.find((entry) => entry.name === name)
    const v17Token = socialContractV17.tokens['0'] as unknown as Record<string, { authorizedToMakeChange?: { $type: string }; adminActionTakers?: { $type: string } }>
    const v16Token = socialContractV16.tokens['0'] as unknown as Record<string, unknown>

    it('keeps follow, follow requests and bookmarks exactly as v16 (D13, D17)', () => {
      for (const docType of ['bookmark', 'follow', 'followRequest']) expect(V17[docType], docType).toEqual(V16[docType])
    })

    it('keys the global timeline, the tag pages and the reply author and thread indexes on the live marker', () => {
      expect(indexOf(V17, 'post', 'timeline')).toEqual({ name: 'timeline', properties: [{ live: 'asc' }, { $createdAt: 'asc' }], rangeCountable: true, skipIfAbsent: true })
      expect(indexOf(V17, 'post', 'tagAndTime')).toEqual({ name: 'tagAndTime', properties: [{ live: 'asc' }, { tags: 'asc' }, { $createdAt: 'asc' }], skipIfAbsent: true })
      expect(indexOf(V17, 'post', 'ownerAndTime')).toEqual(indexOf(V16, 'post', 'ownerAndTime'))
      expect(indexOf(V17, 'reply', 'ownerAndTime')).toEqual({ name: 'ownerAndTime', properties: [{ live: 'asc' }, { $ownerId: 'asc' }, { $createdAt: 'asc' }], skipIfAbsent: true })
      // The live-post total is the timeline's count; the type keeps none of every post.
      expect((V17.post as { documentsCountable?: boolean }).documentsCountable).toBeUndefined()
      expect(V17.reply.properties.live).toEqual({ type: 'boolean', const: true, position: 12 })
      expect(V17.reply.propertyConstraints?.live).toEqual(V17.post.propertyConstraints?.live)
      expect(V17.reply.immutable).toContainEqual({ property: 'live', when: { absent: 'deleted' } })
      // The thread index drops tombstones too. skipIfAbsent names only live: `true`
      // would also skip direct replies, which have no replyToReplyId (10231).
      expect(indexOf(V17, 'reply', 'repliesOf')).toEqual({
        name: 'repliesOf',
        properties: [{ live: 'asc' }, { rootPostId: 'asc' }, { replyToReplyId: 'asc' }, { $createdAt: 'asc' }],
        rangeCountable: true,
        rankedCountable: { at: 'rootPostId' },
        skipIfAbsent: ['live'],
      })
      // The notification windows keep tombstones.
      for (const name of ['rootOwnerRecent', 'parentOwnerRecent']) expect(indexOf(V17, 'reply', name), name).toEqual(indexOf(V16, 'reply', name))
    })

    it('refuses a lone quote owner, an empty reply and self-likes', () => {
      expect(V17.post.propertyConstraints?.quoteOwner).toEqual({ in: [{ countPresent: ['quotedPostId', 'quotedReplyId', 'quotedPostOwnerId'] }, [0, 2]] })
      expect(V17.reply.propertyConstraints?.notEmpty).toBeDefined()
      expect((V17.like.properties.postAuthor as { distinctFrom?: string }).distinctFrom).toBe('$ownerId')
      expect(V17.likeReply.properties.replyId.refersTo?.where).toEqual({ $ownerId: { notEqual: '$ownerId' } })
    })

    it('takes https and ipfs media only, and https websites', () => {
      for (const docType of ['post', 'reply']) {
        expect((V17[docType].properties.mediaUrls as { items: { pattern: string } }).items.pattern, docType).toBe('^(https|ipfs)://.+$')
      }
      const profile = V17.yapprProfile.properties as Record<string, { pattern?: string; maxBytes?: number }>
      expect([profile.bannerUri.pattern, profile.website.pattern]).toEqual(['^(https|ipfs)://.+$', '^https://.+$'])
      expect(new RegExp(profile.avatar.pattern ?? '').test('{"seed":"s","style":"bottts"}')).toBe(true)
      expect(new RegExp(profile.avatar.pattern ?? '').test('http://example.com/a.png')).toBe(false)
      for (const field of ['location', 'website', 'bannerUri', 'pronouns', 'avatar']) expect(profile[field].maxBytes, field).toBeGreaterThan(0)
    })

    it('lets no one mint, burn, freeze, unfreeze or destroy frozen YAPP (D3), and changes nothing else on the token', () => {
      const rules = ['manualMintingRules', 'manualBurningRules', 'freezeRules', 'unfreezeRules', 'destroyFrozenFundsRules']
      for (const rule of rules) {
        expect([v17Token[rule].authorizedToMakeChange?.$type, v17Token[rule].adminActionTakers?.$type], rule).toEqual(['noOne', 'noOne'])
      }
      const rest = (token: Record<string, unknown>) => Object.fromEntries(Object.entries(token).filter(([key]) => !rules.includes(key)))
      expect(rest(v17Token)).toEqual(rest(v16Token))
    })

    it('keeps several write-once private feeds per identity, their caps checked on chain', () => {
      expect(V17.privateFeedState).toBeUndefined()
      expect(V17.privateFeed.indices).toEqual([{ name: 'feed', properties: [{ $ownerId: 'asc' }, { feed: 'asc' }], unique: true }])
      expect([V17.privateFeed.documentsMutable, V17.privateFeed.canBeDeleted, V17.privateFeedRekey.canBeDeleted]).toEqual([false, false, false])
      for (const docType of ['privateFeedGrant', 'privateFeedRekey']) {
        expect((V17[docType].ownerRefersTo as { findBy: unknown }).findBy, docType).toEqual({ $ownerId: '.', feed: 'feed' })
      }
      expect(indexOf(V17, 'privateFeedGrant', 'recipient')?.properties).toEqual([{ recipientId: 'asc' }, { $ownerId: 'asc' }, { feed: 'asc' }])
      for (const docType of ['post', 'reply']) {
        expect(V17[docType].propertyConstraints?.private, docType).toEqual({ in: [{ countPresent: ['encryptedContent', 'keyGeneration', 'nonce', 'feed'] }, [0, 4]] })
        expect(V17[docType].immutable, docType).toContainEqual({ property: 'feed', when: { absent: 'deleted' } })
      }
    })

    it('pins live on repliesOf only where the registered contract keys it on live: the live release file answers until one is recorded, and a registered rootPostId beats it', async () => {
      const repliesOf = (...properties: string[]) => ({ schemas: { reply: { indices: [{ name: 'repliesOf', properties: properties.map((property) => ({ [property]: 'asc' })) }] } } })
      const registeredAs = async (topology: string, contract: ReturnType<typeof repliesOf> | null) => {
        const topologyApi = await topologyModule(topology)
        if (contract) {
          const [{ rememberRegisteredContract }, { YAPPR_CONTRACT_ID }] = await Promise.all([import('./registered-contracts'), import('./constants')])
          rememberRegisteredContract(YAPPR_CONTRACT_ID, contract)
        }
        return [topologyApi.replyThreadsCarryLiveMarker(), topologyApi.replyThreadIndexPrefix()]
      }
      // The release (production testnet): live-keyed, recorded or not.
      expect(await registeredAs('v17', null)).toEqual([true, [['live', '==', true]]])
      expect(await registeredAs('v17', repliesOf('live', 'rootPostId', 'replyToReplyId', '$createdAt'))).toEqual([true, [['live', '==', true]]])
      // /staging, /testing and sakura registered the earlier v17 cut: no pin.
      expect(await registeredAs('v17', repliesOf('rootPostId', 'replyToReplyId', '$createdAt'))).toEqual([false, []])
      // Before v17 a reply carries no live marker at all.
      expect(await registeredAs('v16', repliesOf('live', 'rootPostId'))).toEqual([false, []])
    })

    it('reads the live-keyed listings with live pinned, and keeps every v16 surface', async () => {
      const v17 = await topologyModule('v17')
      expect([v17.postListingsCarryLiveMarker(), v17.repliesCarryLiveMarker(), v17.replyThreadsCarryLiveMarker()]).toEqual([true, true, true])
      expect(v17.postListingWherePrefix()).toEqual([['live', '==', true]])
      expect([v17.replyOwnerIndexPrefix(), v17.replyOwnerIndexOrderPrefix()]).toEqual([[['live', '==', true]], [['live', 'asc']]])
      expect([v17.yappCanBeFrozen(), v17.privateFeedsAreMultiple(), v17.privateFeedClientSupported()]).toEqual([false, true, true])
      expect(v17.ownerDistinctProperties('like')).toEqual(['postAuthor'])
      expect(v17.reportShape().maxReason).toBe(31)
      const v16 = await topologyModule('v16')
      expect([v16.postListingsCarryLiveMarker(), v16.repliesCarryLiveMarker(), v16.replyThreadsCarryLiveMarker(), v16.postListingWherePrefix(), v16.replyOwnerIndexPrefix()]).toEqual([false, false, false, [], []])
      expect([v16.yappCanBeFrozen(), v16.privateFeedsAreMultiple(), v16.privateFeedClientSupported()]).toEqual([true, false, false])
      expect((await topologyModule('v2')).yappCanBeFrozen()).toBe(true)
      const surfaces = async (topology: string) => {
        const m = await topologyModule(topology)
        return { descriptor: { ...m.topologyDescriptor(), topology: null }, tags: m.inlineTags(), mentions: m.inlineMentions(), windows: (['reply', 'quote', 'threadReply'] as const).map((source) => m.notificationWindowFor(source)) }
      }
      expect(await surfaces('v17')).toEqual(await surfaces('v16'))
    })

    it('lets one moderator remove a post or reply for a day (D39), then two approvals with the leader (D41), where v16 kept a week and three', async () => {
      const settled = async (topology: string) => {
        const m = await topologyModule(topology)
        return (['post', 'reply'] as const).map((docType) => [m.settledDeletionFor(docType), m.moderatorDeleteWindowSeconds(docType)])
      }
      const rule = (windowSeconds: number, approvals: number) => [{ windowSeconds, leaderRequired: true, approvals }, windowSeconds]
      expect(await settled('v17')).toEqual([rule(86_400, 2), rule(86_400, 2)])
      expect(await settled('v16')).toEqual([rule(604_800, 3), rule(604_800, 3)])
    })
  })
  describe('v18 (hide, don\'t delete)', () => {
    const indexOf = (schemas: Schemas, docType: string, name: string) => schemas[docType].indices?.find((entry) => entry.name === name)
    const keys = (schemas: Schemas, docType: string, name: string) => indexOf(schemas, docType, name)?.properties.map((property) => Object.keys(property)[0])
    const BLOG10 = blogContractV10.documentSchemas as unknown as Schemas
    const STORE11 = storefrontContractV11.documentSchemas as unknown as Schemas

    it('reports the v18 capabilities on v18 and none of them on v17', async () => {
      const flags = (m: Awaited<ReturnType<typeof topologyModule>>) => [m.listingsCarryModLane(), m.moderatorsCannotDelete(), m.authorsCanBeRestricted()]
      expect(flags(await topologyModule('v18'))).toEqual([true, true, true])
      expect(flags(await topologyModule('v17'))).toEqual([false, false, false])
    })

    it('lets no moderator delete in social, blog or storefront, and keeps warnings only', async () => {
      for (const [name, schemas] of [['social', V18], ['blog', BLOG10], ['storefront', STORE11]] as const) {
        for (const [docType, schema] of Object.entries(schemas)) expect(schema.moderatorAbilities?.delete, `${name}.${docType}`).toBeUndefined()
      }
      for (const contract of [socialContractV18, blogContractV10, storefrontContractV11]) {
        const moderation = contract.config.moderation as { banlist?: boolean; suspensions?: boolean; warnings?: boolean; moderators: { interim: { $type: string }; challengeCoolDown: number } }
        expect([moderation.banlist, moderation.suspensions, moderation.warnings]).toEqual([undefined, undefined, true])
        expect([moderation.moderators.interim.$type, moderation.moderators.challengeCoolDown]).toEqual(['notYetUsable', 1_209_600])
      }
      const v18 = await topologyModule('v18')
      expect(v18.moderatorDeletableTypes()).toEqual([])
      expect(v18.moderationListsKept()).toEqual(['warnings'])
      expect(v18.settledDeletionFor('post')).toBeNull()
    })

    it('keys every listing with mod after live, before the ranked-at property, and logs every moderated type', () => {
      expect(keys(V18, 'post', 'timeline')).toEqual(['live', 'mod', '$createdAt'])
      expect(keys(V18, 'post', 'tagAndTime')).toEqual(['live', 'mod', 'tags', '$createdAt'])
      expect(keys(V18, 'post', 'ownerAndTime')).toEqual(['live', 'mod', '$ownerId', '$createdAt'])
      expect(keys(V18, 'reply', 'ownerAndTime')).toEqual(['live', 'mod', '$ownerId', '$createdAt'])
      expect(keys(V18, 'reply', 'repliesOf')).toEqual(['live', 'mod', 'rootPostId', 'replyToReplyId', '$createdAt'])
      expect(indexOf(V18, 'post', 'ownerAndTime')?.rankedCountable).toEqual({ at: '$ownerId' })
      expect(indexOf(V18, 'reply', 'repliesOf')?.rankedCountable).toEqual({ at: 'rootPostId' })
      for (const docType of ['post', 'reply']) {
        expect(keys(V18, docType, 'mentionedUserAndTime'), docType).toEqual(['mentionedUserIds', 'mod', '$createdAt'])
        // `true` would also skip on `mod`, dropping every unmoderated document.
        for (const name of ['timeline', 'tagAndTime', 'ownerAndTime', 'repliesOf']) {
          const index = indexOf(V18, docType, name)
          if (index) expect(index.skipIfAbsent, `${docType}.${name}`).toEqual(['live'])
        }
      }
      const log = { name: 'moderated', properties: [{ mod: 'asc' }, { $moderatedAt: 'asc' }], skipIfAbsent: ['mod'] }
      for (const [schemas, docTypes] of [[V18, ['post', 'reply', 'yapprProfile']], [BLOG10, ['blog', 'blogPost', 'blogComment']], [STORE11, ['store', 'storeItem', 'storeReview', 'itemReview']]] as const) {
        for (const docType of docTypes) {
          expect(indexOf(schemas, docType, 'moderated'), docType).toEqual(log)
          expect(schemas[docType].moderatorAbilities, docType).toEqual({ changeFields: ['mod', 'modLabel'] })
          expect(schemas[docType].propertyConstraints?.modReason, docType).toEqual({ anyOf: [{ absent: 'mod' }, { present: 'modLabel' }] })
        }
      }
      expect(keys(BLOG10, 'blog', 'timeline')).toEqual(['mod', '$createdAt'])
      expect(keys(BLOG10, 'blogPost', 'timeline')).toEqual(['live', 'mod', '$createdAt'])
      expect(keys(BLOG10, 'blogPost', 'blogAndTime')).toEqual(['live', 'mod', 'blogId', '$createdAt'])
      expect(keys(BLOG10, 'blogComment', 'postAndTime')).toEqual(['blogPostId', 'mod', '$createdAt'])
      expect(keys(STORE11, 'store', 'byCategory')).toEqual(['status', 'mod', 'category', '$createdAt'])
      expect(keys(STORE11, 'storeReview', 'storeRating')).toEqual(['mod', 'storeId'])
      expect(keys(STORE11, 'itemReview', 'storeItemRating')).toEqual(['mod', 'storeId', 'itemId'])
    })

    it('restricts by a moderator-only restriction document that forces live 2 on create only', () => {
      for (const [schemas, docTypes] of [[V18, ['post', 'reply']], [BLOG10, ['blogPost']]] as const) {
        expect(schemas.restriction.moderatorAbilities).toEqual({ changeFields: ['state', 'reason'] })
        expect(indexOf(schemas, 'restriction', 'standing')).toEqual({ name: 'standing', properties: [{ target: 'asc' }, { state: 'asc' }], countable: 'countable' })
        for (const docType of docTypes) {
          const live = schemas[docType].properties.live as unknown as { type: string; minimum: number; maximum: number }
          expect([live.type, live.minimum, live.maximum], docType).toEqual(['integer', 1, 2])
          expect(schemas[docType].propertyConstraints?.restrictedLane, docType).toEqual({
            ifThen: [{ equal: ['$revision', 1] }, { equal: ['live', { add: [1, { min: [{ countOf: ['restriction', { target: '$ownerId', state: 1 }] }, 1] }] }] }],
          })
          // Nobody is ever barred, so there is no retraction for a barred owner to make (10231).
          expect(schemas[docType].retractedWhen, docType).toBeUndefined()
        }
      }
      expect(STORE11.restriction).toBeUndefined()
      // Reviews are permanent, so a hidden one can not be deleted and written again (owner, 2026-10-22).
      for (const docType of ['storeReview', 'itemReview']) expect(STORE11[docType].canBeDeleted, docType).toBe(false)
      for (const property of ['storeReviewId', 'itemReviewId']) expect(STORE11.report.properties[property].refersTo?.type, property).toBe('permanentDocument')
    })

    it('points every reference at a post or reply as permanentDocument, keeps the v17 like and quiets restricted authors\' mentions', () => {
      for (const [docType, property] of [['like', 'postId'], ['likeReply', 'replyId'], ['bookmark', 'postId'], ['post', 'quotedPostId'], ['post', 'quotedReplyId'], ['reply', 'rootPostId'], ['reply', 'replyToReplyId'], ['report', 'postId'], ['report', 'replyId']]) {
        expect(V18[docType].properties[property].refersTo?.type, `${docType}.${property}`).toBe('permanentDocument')
      }
      // Likes are v17's exactly but for the reference kind (owner, 2026-10-22).
      const v17Like = structuredClone(V17.like)
      v17Like.properties.postId.refersTo = { ...v17Like.properties.postId.refersTo, type: 'permanentDocument' }
      expect(V18.like).toEqual(v17Like)
      for (const docType of ['post', 'reply']) {
        expect(V18[docType].propertyConstraints?.restrictedQuiet, docType).toEqual({ ifThen: [{ equal: ['live', 2] }, { absent: 'mentionedUserIds' }] })
      }
      // A hidden profile (unique per owner) cannot be deleted and written again.
      expect(V18.yapprProfile.deleteConstraints).toEqual({ notHidden: { absent: 'mod' } })
    })

    it('carries mod and modLabel through a tombstone, and keeps every v17 surface', async () => {
      const v18 = await topologyModule('v18')
      expect(v18.tombstonePreservationFor('post')).toEqual({ identifiers: [], scalars: ['tags', 'mod', 'modLabel'] })
      expect(v18.tombstonePreservationFor('reply')).toEqual({ identifiers: ['rootPostId', 'replyToReplyId'], scalars: ['mod', 'modLabel'] })
      for (const kind of ['post', 'reply'] as const) {
        const preserved = [...v18.tombstonePreservationFor(kind).identifiers, ...v18.tombstonePreservationFor(kind).scalars]
        for (const field of V18[kind].moderatorAbilities?.changeFields ?? []) expect(preserved, `${kind}.${field}`).toContain(field)
      }
      const v17 = await topologyModule('v17')
      expect(v18.topologyDescriptor().interactions).toEqual(v17.topologyDescriptor().interactions)
      expect(v18.topologyDescriptor().replyLinkage).toEqual(v17.topologyDescriptor().replyLinkage)
    })

    it('fails closed in the v17-shaped listing builders until the v18 ones are wired', async () => {
      const v18 = await topologyModule('v18')
      for (const builder of [v18.postOwnerIndexPrefix, v18.postListingWherePrefix, v18.replyOwnerIndexPrefix, v18.replyThreadIndexPrefix, v18.postOwnerIndexOrderPrefix, v18.replyOwnerIndexOrderPrefix]) {
        expect(() => builder(), builder.name).toThrow(/v18 listing builders are not wired yet/)
      }
      const v17 = await topologyModule('v17')
      expect(v17.postListingWherePrefix()).toEqual([['live', '==', true]])
    })

    it('gates blog v10 and storefront v11 on their own topologies', async () => {
      const constants = async (blog: string, storefront: string) => {
        vi.resetModules()
        vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', blog)
        vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', storefront)
        const m = await import('./constants')
        return [m.blogListingsCarryModLane(), m.blogAuthorsCanBeRestricted(), m.storefrontListingsCarryModLane()]
      }
      expect(await constants('v10', 'v11')).toEqual([true, true, true])
      expect(await constants('v9', 'v10')).toEqual([false, false, false])
    })
  })
})
