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
import socialContractV9 from '@/contracts/yappr-social-contract-v9.json'
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

    it('reads pre-v8 token amounts that still match the v7 contract', async () => {
      // `tokenCostFor` reads the v8 JSON whatever the configured topology, so an
      // edit to the v8 contract's amounts would silently change what a
      // v7-configured client sends — and v7 is what is live. Pin them together.
      const v7 = await topologyModule('v7')
      const v7Schemas = socialContractV7.documentSchemas as unknown as Record<string, { tokenCost?: { create?: { amount: number } } }>
      for (const [docType, schema] of Object.entries(v7Schemas)) {
        const declared = schema.tokenCost?.create?.amount
        expect(v7.tokenCostFor(docType)?.amount ?? null, `${docType} token cost`).toBe(declared ?? null)
      }
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

    it('names exactly the optional deletable references a tombstone may clear', async () => {
      const v8 = await topologyModule('v8')
      expect(v8.clearableReferencesFor('post')).toEqual(['quotedPostId', 'quotedReplyId'])
      // rootPostId is a deletable reference too, but required: it can never be cleared.
      expect(v8.clearableReferencesFor('reply')).toEqual(['replyToReplyId'])
      expect(v8.clearableReferencesFor('like')).toEqual([])
      const v7 = await topologyModule('v7')
      expect(v7.clearableReferencesFor('post')).toEqual([])
      // Every clearable reference is one the tombstone would otherwise preserve.
      for (const kind of ['post', 'reply'] as const) {
        for (const name of v8.clearableReferencesFor(kind)) expect(v8.tombstonePreservationFor(kind).identifiers).toContain(name)
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
      // The tip doctypes only exist from v9, so a v8 client must not think it
      // can pay for one — it would attach a payment agreement for a type the
      // contract does not have.
      expect(v8.tokenCostFor('tip')).toBeNull()
      expect(v8.tokenCostFor('tipReply')).toBeNull()

      expect(v8.starterGrantAmount()).toBe(100n)

      // ~$0.05 and ~$0.01 at $60/DASH (1 DASH = 1e11 credits), moderators pot only.
      expect(v8.declaredActionFee('post', 'create')).toEqual({ owner: 0n, moderators: 80_000_000n, pricing: 'feeMultiplier' })
      expect(v8.declaredActionFee('reply', 'create')).toEqual({ owner: 0n, moderators: 16_000_000n, pricing: 'feeMultiplier' })
      for (const [docType, action] of [['post', 'replace'], ['post', 'delete'], ['like', 'create'], ['repost', 'create'], ['follow', 'create']] as const) {
        expect(v8.declaredActionFee(docType, action)).toBeNull()
      }
      // The write path can only agree to a fee on CREATE (the facade's replace
      // and delete carry no agreement, and the tombstone path is a replace), so
      // a cut pricing any other action would turn every tombstone into a paid
      // 40132. Pin that no type prices anything but create.
      const schemas = socialContractV8.documentSchemas as unknown as Record<string, { actionFees?: Record<string, unknown> }>
      for (const [name, schema] of Object.entries(schemas)) {
        const priced = Object.keys(schema.actionFees ?? {}).filter((key) => key !== 'pricing')
        expect(priced, `${name} prices an action the client cannot agree to`).toEqual(schema.actionFees ? ['create'] : [])
      }
    })
  })

  describe('v9 proved tips', () => {
    it('has no tip surface before v9, so nothing reads or writes one', async () => {
      const v8 = await topologyModule('v8')
      expect(v8.provedTipsAvailable()).toBe(false)
      expect(v8.tipSurfaceFor('post')).toBeNull()
      expect(v8.tipSurfaceFor('reply')).toBeNull()
    })

    it('names the doctype and tipped field each kind\'s tips live in', async () => {
      const v9 = await topologyModule('v9')
      expect(v9.provedTipsAvailable()).toBe(true)
      expect(v9.tipSurfaceFor('post')).toEqual({ docType: 'tip', tippedField: 'postId', threadField: null })
      expect(v9.tipSurfaceFor('reply')).toEqual({ docType: 'tipReply', tippedField: 'replyId', threadField: 'rootPostId' })
    })

    it('pins the tip fields the client writes against the v9 JSON', async () => {
      const schemas = socialContractV9.documentSchemas as unknown as Record<string, {
        required: string[]
        properties: Record<string, { refersTo?: { type: string; documentType?: string; contractId?: number[]; propertyAgreement?: Record<string, string> } }>
      }>
      for (const [docType, tippedField] of [['tip', 'postId'], ['tipReply', 'replyId']] as const) {
        const schema = schemas[docType]
        // Everything `recordTip` sends is required, so a missing field is a
        // rejection rather than a tip that renders with a hole in it.
        expect(schema.required.sort()).toEqual(['$createdAt', 'amount', 'recipientId', tippedField, 'transferId'].sort())
        // The amount is bound to the cited transfer, and the payee to the
        // tipped document's author — this is what makes the read path's
        // numbers facts rather than the tipper's word.
        expect(schema.properties.transferId.refersTo?.propertyAgreement).toEqual({
          $ownerId: '$ownerId', amount: 'amount', recipientId: 'toIdentityId',
        })
        expect(schema.properties[tippedField].refersTo?.propertyAgreement).toEqual({ recipientId: '$ownerId' })
        expect(schema.properties.transferId.refersTo?.contractId).toHaveLength(32)
      }
    })

    it('carries every v8 capability into v9 unchanged', async () => {
      const v9 = await topologyModule('v9')
      expect(v9.contractIsModerated()).toBe(true)
      expect(v9.referencesMayDangle()).toBe(true)
      expect(v9.moderatorDeletableTypes()).toEqual(['post', 'reply'])
      expect(v9.tokenCostFor('post')).toEqual({ amount: 10, optional: true, gasFeesPaidBy: 2 })
      expect(v9.tokenCostFor('tip')).toEqual({ amount: 1, optional: true, gasFeesPaidBy: 2 })
      expect(v9.declaredActionFee('reply', 'create')).toEqual({ owner: 0n, moderators: 16_000_000n, pricing: 'feeMultiplier' })
      // A tip charges no action fee: the words it may carry live in a reply
      // that pays one already.
      expect(v9.declaredActionFee('tip', 'create')).toBeNull()
    })
  })
})
