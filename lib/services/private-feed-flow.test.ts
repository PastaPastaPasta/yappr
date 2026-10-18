/**
 * Private feeds end to end on social v17, without a network: the real owner,
 * follower, reader and move services against an in-memory chain that keeps
 * the contract's unique indexes, its follow-request and feed references and
 * the stored caps (docs/SOCIAL_V17.md). One scenario walks every flow the
 * release needs: enable, approve, post, revoke, renew with the history link,
 * a fresh start, a renewal after the owner's key changed without the old
 * secret, and leaving.
 */
import bs58 from 'bs58'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from '@/lib/crypto/keys'
import { bytesToBase64 } from '@/lib/bytes'
import type { PrivateContent } from './private-feed-reader'

type Doc = Record<string, unknown> & { $id: string; $ownerId: string; $type: string; $createdAt: number }

const chain = vi.hoisted(() => ({
  docs: [] as Record<string, unknown>[],
  clock: 1_000,
  ids: 0,
  identities: new Map<string, { publicKeys: Record<string, unknown>[] }>(),
  session: new Map<string, Uint8Array>(),
  writes: [] as string[],
  /** The next create is sent but never lands, and comes back unconfirmed (a timed-out wait). */
  dropNextCreate: false,
  /** Runs once after the next grant lands (another device acting in the middle of a move). */
  afterGrant: null as null | (() => Promise<void>),
  /** The next create lands but stays invisible to reads (and comes back unconfirmed) until `hidden` is cleared. */
  lateNextCreate: false,
  hidden: new Set<string>(),
}))

const UNIQUE: Record<string, string[][]> = {
  privateFeed: [['$ownerId', 'feed']],
  privateFeedGrant: [['recipientId', '$ownerId', 'feed'], ['$ownerId', 'feed', 'leafIndex']],
  privateFeedRekey: [['$ownerId', 'feed', 'keyGeneration']],
  followRequest: [['targetId', '$ownerId']],
}

const norm = (value: unknown) => (value instanceof Uint8Array ? bs58.encode(value) : value)
const field = (doc: Record<string, unknown>, name: string) => norm(doc[name])

function query(q: { documentTypeName: string; where?: [string, string, unknown][]; orderBy?: [string, 'asc' | 'desc'][]; limit?: number; startAfter?: string }) {
  let rows = chain.docs.filter((doc) => !chain.hidden.has(doc.$id as string) && doc.$type === q.documentTypeName && (q.where ?? []).every(([name, op, value]) => {
    const actual = field(doc, name) as number | string
    if (op === '==') return actual === value
    if (op === '>') return Number(actual) > Number(value)
    throw new Error(`fake chain: no operator ${op}`)
  }))
  for (const [name, direction] of [...(q.orderBy ?? [])].reverse()) {
    rows = [...rows].sort((a, b) => {
      const [x, y] = [field(a, name) as number | string, field(b, name) as number | string]
      return (x < y ? -1 : x > y ? 1 : 0) * (direction === 'desc' ? -1 : 1)
    })
  }
  if (q.startAfter) rows = rows.slice(rows.findIndex((doc) => doc.$id === q.startAfter) + 1)
  return new Map(rows.slice(0, q.limit ?? 100).map((doc) => [doc.$id, { ...doc }]))
}

function refuse(error: string) {
  return { success: false, error }
}

async function createDocument(_contract: string, type: string, ownerId: string, data: Record<string, unknown>) {
  if (chain.dropNextCreate) {
    chain.dropNextCreate = false
    return { success: true, confirmed: false }
  }
  const doc: Doc = { ...data, $id: bs58.encode(new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? ++chain.ids % 256 : i === 1 ? chain.ids >> 8 : 7))), $ownerId: ownerId, $type: type, $createdAt: ++chain.clock, $revision: 1 }
  for (const index of UNIQUE[type] ?? []) {
    if (chain.docs.some((other) => other.$type === type && index.every((name) => field(other, name) === field(doc, name)))) {
      return refuse(`Document ${doc.$id} has duplicate unique properties ${JSON.stringify(index)} (code 40105)`)
    }
  }
  if (type === 'privateFeedGrant' || type === 'privateFeedRekey') {
    const feed = chain.docs.find((other) => other.$type === 'privateFeed' && other.$ownerId === ownerId && other.feed === data.feed)
    if (!feed) return refuse(`referenced permanent document privateFeed not found for path $ownerId (code 40120)`)
    const leaf = (data.leafIndex ?? data.revokedLeaf) as number
    if (leaf >= (feed.treeCapacity as number) || (data.keyGeneration as number) > (feed.maxKeyGeneration as number)) {
      return refuse('the document\'s { "greaterThan": "leafIndex" } does not agree with the referenced document\'s treeCapacity (code 40127)')
    }
  }
  if (type === 'privateFeedGrant') {
    const asked = chain.docs.some((other) => other.$type === 'followRequest' && other.$ownerId === norm(data.recipientId) && field(other, 'targetId') === ownerId)
    if (!asked) return refuse(`referenced deletable document followRequest not found for path recipientId (code 40120)`)
  }
  chain.docs.push(doc)
  chain.writes.push(type)
  if (chain.lateNextCreate) {
    chain.lateNextCreate = false
    chain.hidden.add(doc.$id)
    return { success: true, confirmed: false, document: doc }
  }
  if (type === 'privateFeedGrant' && chain.afterGrant) {
    const run = chain.afterGrant
    chain.afterGrant = null
    await run()
  }
  return { success: true, document: doc }
}

async function deleteDocument(_contract: string, type: string, id: string, ownerId: string) {
  if (type === 'privateFeed' || type === 'privateFeedRekey') return refuse(`documents of type ${type} can not be deleted (code 10404)`)
  const index = chain.docs.findIndex((doc) => doc.$id === id && doc.$ownerId === ownerId)
  if (index < 0) return refuse('not found')
  chain.docs.splice(index, 1)
  chain.writes.push(`delete ${type}`)
  return { success: true }
}

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: async (q: Parameters<typeof query>[0]) => query(q) } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument, deleteDocument } }))
vi.mock('./identity-service', () => ({ identityService: { getIdentity: async (id: string) => chain.identities.get(id) ?? null } }))
vi.mock('@/lib/secure-storage', () => ({ getEncryptionKeyBytes: (id: string) => chain.session.get(id) ?? null }))

/** A browser for the key store, the move job and the owner's answered requests. */
function installWindow() {
  const items = new Map<string, string>()
  const localStorage = {
    get length() { return items.size },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v) },
    removeItem: (k: string) => { items.delete(k) },
    clear: () => items.clear(),
  }
  vi.stubGlobal('window', { localStorage, addEventListener: () => undefined, removeEventListener: () => undefined })
}

const ident = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const secret = (n: number) => new Uint8Array(32).fill(n)
const [O, F1, F2, F3, F4, F5, P] = [ident(1), ident(2), ident(3), ident(4), ident(5), ident(6), ident(7)]
const keys: Record<string, Uint8Array> = { [O]: secret(41), [F1]: secret(42), [F2]: secret(43), [F3]: secret(44), [F4]: secret(45), [F5]: secret(46), [P]: secret(47) }

function giveEncryptionKey(identityId: string, key: Uint8Array, id = 2, disabledKeys: Record<string, unknown>[] = []) {
  chain.identities.set(identityId, { publicKeys: [...disabledKeys, { id, type: 0, purpose: 1, securityLevel: 2, data: bytesToBase64(getPublicKey(key)) }] })
  chain.session.set(identityId, key)
}

type Services = {
  owner: typeof import('./private-feed-service')
  follower: typeof import('./private-feed-follower-service')['privateFeedFollowerService']
  reader: typeof import('./private-feed-reader')
  move: typeof import('./private-feed-move')
  store: typeof import('./private-feed-key-store')['privateFeedKeyStore']
}
let s: Services

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v17')
  installWindow()
  for (const [id, key] of Object.entries(keys)) giveEncryptionKey(id, key)
  s = {
    owner: await import('./private-feed-service'),
    follower: (await import('./private-feed-follower-service')).privateFeedFollowerService,
    reader: await import('./private-feed-reader'),
    move: await import('./private-feed-move'),
    store: (await import('./private-feed-key-store')).privateFeedKeyStore,
  }
})
afterAll(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function post(text: string, owner = O): Promise<PrivateContent> {
  const sealed = await s.owner.prepareOwnerEncryption(owner, text, 'post', undefined, keys[owner])
  if (!sealed.success) throw new Error(sealed.error)
  return { feedOwnerId: owner, feed: sealed.data.feed, keyGeneration: sealed.data.keyGeneration, nonce: sealed.data.nonce, encryptedContent: sealed.data.encryptedContent, authorId: owner, kind: 'post' }
}

async function read(viewer: string, content: PrivateContent): Promise<string> {
  const outcome = await s.reader.decryptPrivateContent(content, viewer, keys[viewer])
  return outcome.ok ? outcome.text : `<${outcome.reason}>`
}

async function approve(...followers: string[]) {
  await approveBy(O, ...followers)
}

async function approveBy(owner: string, ...followers: string[]) {
  for (const follower of followers) {
    const result = await s.owner.privateFeedService.approveFollower(owner, follower, getPublicKey(keys[follower]), keys[owner])
    expect(result, follower).toEqual({ success: true })
  }
}

const NAMES: Record<string, string> = { [O]: 'O', [F1]: 'F1', [F2]: 'F2', [F3]: 'F3', [F4]: 'F4', [F5]: 'F5' }
const grantsIn = (feed: number) => chain.docs.filter((doc) => doc.$type === 'privateFeedGrant' && doc.feed === feed).map((doc) => NAMES[norm(doc.recipientId) as string]).sort()

const grantsOf = (owner: string, feed: number) => chain.docs.filter((doc) => doc.$type === 'privateFeedGrant' && doc.$ownerId === owner && doc.feed === feed).map((doc) => norm(doc.recipientId))

describe('private feeds v2 end to end', () => {
  const posts: Record<string, PrivateContent> = {}

  it('enables feed 1 with the release defaults, and approves three followers who asked', async () => {
    expect(await s.owner.privateFeedService.enablePrivateFeed(O, keys[O])).toEqual({ success: true })
    const feed = await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true })
    expect(feed).toMatchObject({ feed: 1, treeCapacity: 4096, maxKeyGeneration: 4095, keyId: 2 })
    expect(await s.owner.privateFeedService.approveFollower(O, F1, getPublicKey(keys[F1]), keys[O])).toMatchObject({ errorCode: 'REQUEST_WITHDRAWN' })
    for (const follower of [F1, F2, F3]) expect(await s.follower.requestAccess(O, follower)).toEqual({ success: true })
    expect((await s.owner.privateFeedService.getPendingRequests(O)).map((r) => r.$ownerId).sort()).toEqual([F1, F2, F3].sort())
    await approve(F1, F2, F3)
    expect(await s.owner.privateFeedService.getPendingRequests(O)).toEqual([])
    expect(await s.follower.getAccessStatus(O, F1)).toBe('approved-no-keys')
  })

  it('posts privately; every member reads it, recovering their keys from the grant', async () => {
    posts.one = await post('one')
    for (const follower of [F1, F2, F3]) expect(await read(follower, posts.one)).toBe('one')
    expect(await s.follower.getAccessStatus(O, F1)).toBe('approved')
    expect(await read(F4, posts.one)).toBe('<no-access>')
    expect(await read(O, posts.one)).toBe('one')
  })

  it('revokes F2: the others follow the new key, F2 keeps only what it already had', async () => {
    expect(await s.owner.privateFeedService.revokeFollower(O, F2, keys[O])).toEqual({ success: true })
    posts.two = await post('two')
    expect(posts.two.keyGeneration).toBe(2)
    expect([await read(F1, posts.two), await read(F3, posts.two), await read(F2, posts.two)]).toEqual(['two', 'two', '<revoked>'])
    expect(await read(F2, posts.one)).toBe('one')
    expect(await s.follower.getAccessStatus(O, F2)).toBe('revoked')
    // F2's standing request does not come back as pending to the owner who revoked it.
    expect(await s.owner.privateFeedService.getPendingRequests(O)).toEqual([])
  })

  it('renews with the history link: followers move, old grants go, and a newcomer reads everything', async () => {
    expect((await s.move.estimateRenewal(O)).followers).toBe(2)
    const renewed = await s.move.renewPrivateFeed(O, keys[O], { bringHistory: true })
    expect(renewed).toMatchObject({ success: true, historyLinked: true })
    expect(grantsIn(2)).toEqual(['F1', 'F3'].sort())
    // The moved followers' old grants go (PF6); the removed F2's stays as the record of the answer.
    expect(grantsIn(1)).toEqual(['F2'])
    posts.three = await post('three')
    expect(posts.three.feed).toBe(2)
    expect([await read(F1, posts.three), await read(F1, posts.one), await read(F2, posts.three)]).toEqual(['three', 'one', '<no-access>'])
    expect(await s.follower.getAccessStatus(O, F2)).toBe('revoked')
    await s.follower.requestAccess(O, F4)
    await approve(F4)
    expect([await read(F4, posts.one), await read(F4, posts.two), await read(F4, posts.three)]).toEqual(['one', 'two', 'three'])
  })

  it('a fresh start keeps the old grants and gives newcomers nothing from before it', async () => {
    const renewed = await s.move.renewPrivateFeed(O, keys[O], { bringHistory: false })
    expect(renewed).toMatchObject({ success: true, historyLinked: false })
    expect(grantsIn(3)).toEqual(['F1', 'F3', 'F4'].sort())
    expect(grantsIn(2)).toEqual(['F1', 'F3', 'F4'].sort())
    posts.four = await post('four')
    await s.follower.requestAccess(O, F5)
    await approve(F5)
    expect([await read(F5, posts.four), await read(F5, posts.three)]).toEqual(['four', '<history-unavailable>'])
    expect([await read(F4, posts.four), await read(F4, posts.three)]).toEqual(['four', 'three'])
    // The owner on a new device still opens the seed of the feed before the fresh start (sealed to the same key).
    s.store.clearIdentity(O)
    expect(await read(O, posts.three)).toBe('three')
  })

  it('after the owner\'s key changes on a device without the old secret, renewing opens a feed with no history link', async () => {
    const rotated = secret(51)
    giveEncryptionKey(O, rotated, 3, [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data: bytesToBase64(getPublicKey(keys[O])), disabledAt: 1 }])
    keys[O] = rotated
    s.store.clearIdentity(O)
    expect((await s.owner.privateFeedService.getOverview(O))).toMatchObject({ keyRotated: true })
    expect(await s.move.canBringHistory(O, rotated)).toBe('no')
    const renewed = await s.move.renewPrivateFeed(O, rotated, { bringHistory: true })
    expect(renewed).toMatchObject({ success: true, historyLinked: false })
    expect((await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true }))).toMatchObject({ feed: 4, keyId: 3 })
    expect(grantsIn(3)).toEqual(['F1', 'F3', 'F4', 'F5'].sort())
    posts.five = await post('five')
    expect([await read(F1, posts.five), await read(F1, posts.four)]).toEqual(['five', 'four'])
    expect(await read(O, posts.four)).toBe('<history-unavailable>')
  })

  it('a follower who leaves is not carried into the next renewal, and cannot be approved again without asking', async () => {
    expect(await s.follower.leave(O, F3)).toEqual({ success: true })
    expect(await s.owner.privateFeedService.approveFollower(O, F3, getPublicKey(keys[F3]), keys[O])).toMatchObject({ errorCode: 'REQUEST_WITHDRAWN' })
    // F3 still holds a grant in feed 4 (leaving does not revoke); the next renewal leaves them out.
    const renewed = await s.move.renewPrivateFeed(O, keys[O], { bringHistory: true })
    expect(renewed.success).toBe(true)
    expect(grantsIn(5)).not.toContain('F3')
    expect(grantsIn(5)).toContain('F1')
    expect(await s.follower.getAccessStatus(O, F3)).toBe('none')
  })

  it('a reply under an old private post goes into the owner\'s current feed, readable by its members only', async () => {
    const sealed = await s.owner.prepareInheritedEncryption('a reply', { ownerId: O }, F1)
    if (!sealed.success) throw new Error(sealed.error)
    const current = await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true })
    expect(sealed.data.feed).toBe(current?.feed)
    const reply: PrivateContent = { feedOwnerId: O, feed: sealed.data.feed, keyGeneration: sealed.data.keyGeneration, nonce: sealed.data.nonce, encryptedContent: sealed.data.encryptedContent, authorId: F1, kind: 'reply' }
    expect([await read(O, reply), await read(F4, reply), await read(F3, reply), await read(F2, reply)]).toEqual(['a reply', 'a reply', '<no-access>', '<no-access>'])
    // Quoted, the reply comes as a post by F1: its thread root's owner is whose feed opens it.
    const quoted = { author: { id: F1 }, targetKind: 'reply' as const, parentId: 'root', rootOwnerId: O, ...sealed.data }
    expect(await s.reader.decryptPostOrReply(quoted, F4, keys[F4])).toEqual({ outcome: { ok: true, text: 'a reply' }, feedOwnerId: O })
    // On v17 a reply names no root owner: the root is read, and a private one's author is whose feed it is.
    vi.doMock('./post-service', () => ({ postService: { getPostById: async (id: string) => (id === 'root' ? { author: { id: O }, encryptedContent: new Uint8Array([1]) } : null) } }))
    const fetched = { author: { id: F1 }, targetKind: 'reply' as const, parentId: 'root', rootPostId: 'root', ...sealed.data }
    expect(await s.reader.privateFeedOwnerOf(fetched)).toEqual({ owner: O, certain: true })
    expect(await s.reader.decryptPostOrReply(fetched, F4, keys[F4])).toEqual({ outcome: { ok: true, text: 'a reply' }, feedOwnerId: O })
    // Its root since deleted (a tombstone, no longer saying whether it was private): O's feed is still found.
    vi.doMock('./post-service', () => ({ postService: { getPostById: async () => ({ author: { id: O }, deleted: true }) } }))
    const underTombstone = { ...fetched, rootPostId: 'deleted-root' }
    expect(await s.reader.privateFeedOwnerOf(underTombstone)).toEqual({ owner: O, certain: false })
    expect(await s.reader.decryptPostOrReply(underTombstone, F4, keys[F4])).toEqual({ outcome: { ok: true, text: 'a reply' }, feedOwnerId: O })
    // A card that names the thread's starter but not the root: still O's feed.
    expect(await s.reader.decryptPostOrReply({ ...fetched, rootPostId: undefined }, F4, keys[F4], O)).toEqual({ outcome: { ok: true, text: 'a reply' }, feedOwnerId: O })
    vi.doUnmock('./post-service')
    // F3 left and was not carried: no reply into the current feed.
    expect(await s.owner.prepareInheritedEncryption('nope', { ownerId: O }, F3)).toMatchObject({ success: false })
  })

  it('refuses private posting while a move is unfinished, and resumes it', async () => {
    const { saveMove, loadMove } = await import('./private-feed-move-job')
    const current = await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true })
    saveMove({ ownerId: O, from: 4, to: current?.feed ?? 0, recipients: [F1, F4], done: [], skipped: [], deleteOldGrants: true })
    await expect(post('blocked')).rejects.toThrow(/being moved/)
    expect(await s.move.runMove(O, keys[O])).toEqual({ success: true })
    expect(loadMove(O)).toBeNull()
    expect((await post('open again')).feed).toBe(current?.feed)
  })

  it('a removed follower stays answered on the owner\'s other devices, and comes back only by asking again', async () => {
    const before = await post('before removal')
    expect(await read(F4, before)).toBe('before removal')
    expect(await s.owner.privateFeedService.revokeFollower(O, F4, keys[O])).toEqual({ success: true })
    // Another device of the owner: nothing local.
    s.store.clearIdentity(O)
    expect((await s.owner.privateFeedService.getPendingRequests(O)).map((r) => NAMES[r.$ownerId])).not.toContain('F4')
    expect(await s.follower.getAccessStatus(O, F4)).toBe('revoked')
    const after = await post('after removal')
    expect(await read(F4, after)).toBe('<revoked>')
    expect(await s.follower.requestAccess(O, F4)).toEqual({ success: true })
    expect(await s.follower.getAccessStatus(O, F4)).toBe('pending')
    expect((await s.owner.privateFeedService.getPendingRequests(O)).map((r) => [NAMES[r.$ownerId], r.renewal])).toContainEqual(['F4', true])
    await approve(F4)
    expect([await read(F4, after), await read(F4, await post('back again'))]).toEqual(['after removal', 'back again'])
  })

  it('a revocation that is not confirmed changes nothing locally', async () => {
    const generation = (await s.owner.privateFeedService.getOverview(O))?.keyGeneration
    chain.dropNextCreate = true
    expect(await s.owner.privateFeedService.revokeFollower(O, F4, keys[O])).toMatchObject({ errorCode: 'UNCONFIRMED' })
    expect((await s.owner.privateFeedService.getOverview(O))?.keyGeneration).toBe(generation)
    expect(await read(F4, await post('still here'))).toBe('still here')
  })

  it('content claiming a generation the feed never reached does not open, and costs no key recovery', async () => {
    const real = await post('real')
    expect(await read(F4, { ...real, keyGeneration: real.keyGeneration + 50 })).toBe('<failed>')
    expect(await read(F4, real)).toBe('real')
  })

  it('removing someone still waiting to be moved after a renewal keeps them out of the new feed on every device', async () => {
    const before = (await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true }))?.feed as number
    // A renewal whose device stopped right after opening the feed: nobody moved yet.
    expect((await s.owner.privateFeedService.openFeed(O, keys[O])).success).toBe(true)
    const pending = (await s.owner.privateFeedService.getPendingRequests(O)).map((r) => NAMES[r.$ownerId])
    expect(pending).not.toContain('F1')
    expect(pending).not.toContain('F4')
    expect(await s.move.adoptUnfinishedMove(O)).toBeGreaterThan(0)
    expect(await s.owner.privateFeedService.revokeFollower(O, F4, keys[O])).toEqual({ success: true })
    expect(await s.move.runMove(O, keys[O])).toEqual({ success: true })
    expect(grantsIn(before + 1)).toContain('F1')
    expect(grantsIn(before + 1)).not.toContain('F4')
    expect(await s.follower.getAccessStatus(O, F4)).toBe('revoked')
  })

  it('leaving shows as nothing to the follower, and the owner stops carrying them', async () => {
    expect(await s.follower.leave(O, F1)).toEqual({ success: true })
    expect(await s.follower.getAccessStatus(O, F1)).toBe('none')
  })

  it('a follower removed on another device in the middle of a move is not carried over', async () => {
    for (const follower of [F2, F3, F5]) {
      expect(await s.follower.requestAccess(O, follower)).toEqual({ success: true })
      await approve(follower)
    }
    const before = (await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true }))?.feed as number
    expect((await s.owner.privateFeedService.openFeed(O, keys[O])).success).toBe(true)
    expect(await s.move.adoptUnfinishedMove(O)).toBeGreaterThanOrEqual(2)
    const { loadMove, saveMove } = await import('./private-feed-move-job')
    const last = (loadMove(O)?.recipients ?? []).at(-1) as string
    chain.afterGrant = async () => {
      expect(await s.owner.privateFeedService.revokeFollower(O, last, keys[O])).toEqual({ success: true })
      // The other device's skip never reaches this one's job.
      const job = loadMove(O)
      if (job) saveMove({ ...job, skipped: job.skipped.filter((id) => id !== last) })
    }
    expect(await s.move.runMove(O, keys[O])).toEqual({ success: true })
    const moved = (await s.owner.privateFeedService.getPrivateFollowers(O)).map((f) => f.recipientId)
    expect(moved).not.toContain(last)
    expect(moved.length).toBeGreaterThan(0)
    expect(grantsIn(before + 1)).not.toContain(NAMES[last])
  })

  it('a follower removed elsewhere while their new grant is being written gets that grant taken back', async () => {
    const before = (await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true }))?.feed as number
    const members = (await s.owner.privateFeedService.getPrivateFollowers(O)).map((f) => f.recipientId)
    expect(members.length).toBeGreaterThan(0)
    expect((await s.owner.privateFeedService.openFeed(O, keys[O])).success).toBe(true)
    expect(await s.move.adoptUnfinishedMove(O)).toBeGreaterThan(0)
    const { fetchFeed } = await import('./private-feed-reads')
    let removed = ''
    chain.afterGrant = async () => {
      // Device B, which cannot see this new grant yet, removes its holder in the old feed only.
      const grant = chain.docs.filter((doc) => doc.$type === 'privateFeedGrant').at(-1) as Record<string, unknown>
      removed = norm(grant.recipientId) as string
      const source = chain.docs.find((doc) => doc.$type === 'privateFeedGrant' && doc.feed === before && norm(doc.recipientId) === removed) as Record<string, unknown>
      const oldFeed = await fetchFeed(O, before)
      if (!oldFeed) throw new Error('old feed missing')
      expect((await s.owner.privateFeedService.revokeLeaf(O, oldFeed, source.leafIndex as number, source.keyGeneration as number, keys[O])).success).toBe(true)
    }
    expect(await s.move.runMove(O, keys[O])).toEqual({ success: true })
    expect(removed).not.toBe('')
    const now = (await s.owner.privateFeedService.getPrivateFollowers(O)).map((f) => f.recipientId)
    expect(now).not.toContain(removed)
    expect(await s.follower.getAccessStatus(O, removed)).toBe('revoked')
  })

  it('a renewal confirmed late is finished, not renewed past, when the owner tries again', async () => {
    const before = (await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true }))?.feed as number
    const members = (await s.owner.privateFeedService.getPrivateFollowers(O)).map((f) => NAMES[f.recipientId]).sort()
    expect(members.length).toBeGreaterThan(0)
    chain.lateNextCreate = true
    expect(await s.move.renewPrivateFeed(O, keys[O], { bringHistory: true })).toMatchObject({ success: false, errorCode: 'UNCONFIRMED' })
    chain.hidden.clear()
    expect(await s.move.renewPrivateFeed(O, keys[O], { bringHistory: true })).toMatchObject({ success: false, error: expect.stringMatching(/still being moved/) })
    expect(await s.move.runMove(O, keys[O])).toEqual({ success: true })
    expect((await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true }))?.feed).toBe(before + 1)
    expect(grantsIn(before + 1)).toEqual(members)
  })

  it('a follower moved, then removed in the old feed by a device that did not see the move, loses the new grant on the next device', async () => {
    const before = (await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true }))?.feed as number
    const target = (await s.owner.privateFeedService.getPrivateFollowers(O)).map((f) => f.recipientId)[0]
    expect(target).toBeDefined()
    expect((await s.owner.privateFeedService.openFeed(O, keys[O])).success).toBe(true)
    // Device A writes the new grant and closes before settling it; device B, not seeing it, removes them in the old feed.
    const synced = await s.owner.privateFeedService.ownerFeedState(O, keys[O])
    if (!synced.success) throw new Error('owner state')
    expect(await s.owner.privateFeedService.writeGrant(O, synced.state, target, getPublicKey(keys[target]), 0)).toEqual({ success: true })
    const source = chain.docs.find((doc) => doc.$type === 'privateFeedGrant' && doc.$ownerId === O && doc.feed === before && norm(doc.recipientId) === target) as Record<string, unknown>
    const { fetchFeed } = await import('./private-feed-reads')
    const oldFeed = await fetchFeed(O, before)
    if (!oldFeed) throw new Error('old feed missing')
    expect((await s.owner.privateFeedService.revokeLeaf(O, oldFeed, source.leafIndex as number, source.keyGeneration as number, keys[O])).success).toBe(true)
    // Their own new request, made after the removal, is not the owner approving them again.
    expect(await s.follower.leave(O, target)).toEqual({ success: true })
    expect(await s.follower.requestAccess(O, target)).toEqual({ success: true })
    // A third device finds the move unfinished and takes the grant back.
    expect(await s.move.adoptUnfinishedMove(O)).toBeGreaterThan(0)
    expect(await s.move.runMove(O, keys[O])).toEqual({ success: true })
    expect((await s.owner.privateFeedService.getPrivateFollowers(O)).map((f) => f.recipientId)).not.toContain(target)
    // The take-back answers that request too (fail closed): they can ask again.
    expect(await s.follower.getAccessStatus(O, target)).toBe('revoked')
  })
})

describe('private feeds v2: every authorised path to history', () => {
  const pPosts: Record<string, PrivateContent> = {}

  it('a follower revoked in a feed still reads its later posts through a newer grant\'s history link', async () => {
    expect(await s.owner.privateFeedService.enablePrivateFeed(P, keys[P])).toEqual({ success: true })
    for (const follower of [F1, F2]) await s.follower.requestAccess(P, follower)
    await approveBy(P, F1, F2)
    pPosts.one = await post('p one', P)
    expect(await read(F1, pPosts.one)).toBe('p one')
    expect(await s.owner.privateFeedService.revokeFollower(P, F1, keys[P])).toEqual({ success: true })
    const afterRemoval = await post('p two', P)
    expect(await read(F1, afterRemoval)).toBe('<revoked>')
    expect(await s.move.renewPrivateFeed(P, keys[P], { bringHistory: true })).toMatchObject({ success: true, historyLinked: true })
    await s.follower.requestAccess(P, F1)
    await approveBy(P, F1)
    expect(await read(F1, afterRemoval)).toBe('p two')
  })

  it('a fresh start breaks one walk, not the one from an older grant kept after it', async () => {
    const first = await post('p three', P) // feed 2
    expect(await s.move.renewPrivateFeed(P, keys[P], { bringHistory: false })).toMatchObject({ success: true, historyLinked: false })
    // A fresh device: F2 holds grants in feed 3 (moved) and feed 2 (kept by the fresh start), not in feed 1 (deleted by the linked move).
    s.store.clearIdentity(F2)
    expect(await read(F2, first)).toBe('p three')
    s.store.clearIdentity(F2)
    // Feed 1 is reached only from the kept feed-2 grant: feed 3 has no carry.
    expect(await read(F2, pPosts.one)).toBe('p one')
    const pOne = chain.docs.filter((doc) => doc.$type === 'privateFeedGrant' && doc.$ownerId === P && doc.feed === 1 && norm(doc.recipientId) === F2)
    expect(pOne).toEqual([])
  })

  it('a request re-made before a removal does not count as asking again', async () => {
    await s.follower.requestAccess(P, F2) // a re-request while a member (their key changed, say)
    expect(await s.owner.privateFeedService.revokeFollower(P, F2, keys[P])).toEqual({ success: true })
    expect((await s.owner.privateFeedService.getPendingRequests(P)).map((r) => r.$ownerId)).not.toContain(F2)
    expect(await s.follower.getAccessStatus(P, F2)).toBe('revoked')
    expect(await s.owner.privateFeedService.approveFollower(P, F2, getPublicKey(keys[F2]), keys[P])).toMatchObject({ success: false })
  })

  it('private posting waits for a move the chain shows unfinished, even with nothing kept on this device', async () => {
    expect((await s.owner.privateFeedService.openFeed(P, keys[P])).success).toBe(true)
    const { loadMove } = await import('./private-feed-move-job')
    expect(loadMove(P)).toBeNull()
    await expect(post('blocked', P)).rejects.toThrow(/being moved/)
    expect(loadMove(P)).not.toBeNull()
    expect(await s.move.runMove(P, keys[P])).toEqual({ success: true })
    expect((await post('open', P)).feed).toBeGreaterThan(0)
  })

  it('after a renewal, a request older than a removal in an earlier feed still cannot be approved', async () => {
    expect(grantsOf(P, 4)).not.toContain(F2)
    expect(await s.owner.privateFeedService.approveFollower(P, F2, getPublicKey(keys[F2]), keys[P])).toMatchObject({ success: false })
    expect((await s.owner.privateFeedService.getPendingRequests(P)).map((r) => r.$ownerId)).not.toContain(F2)
  })

  it('a follower who left and asks again after a renewal waits for approval, and private posting goes on', async () => {
    expect(await s.follower.leave(P, F1)).toEqual({ success: true })
    const renewed = await s.move.renewPrivateFeed(P, keys[P], { bringHistory: true })
    expect(renewed).toMatchObject({ success: true })
    const feed = (await post('while away', P)).feed
    expect(grantsOf(P, feed)).not.toContain(F1)
    expect(await s.follower.requestAccess(P, F1)).toEqual({ success: true })
    expect(await s.follower.getAccessStatus(P, F1)).toBe('pending')
    const { loadMove } = await import('./private-feed-move-job')
    const asked = await post('after asking', P)
    expect(loadMove(P)).toBeNull()
    expect(grantsOf(P, feed)).not.toContain(F1)
    expect((await s.owner.privateFeedService.getPendingRequests(P)).map((r) => r.$ownerId)).toContain(F1)
    expect(await s.owner.privateFeedService.approveFollower(P, F1, getPublicKey(keys[F1]), keys[P])).toEqual({ success: true })
    expect(grantsOf(P, feed)).toContain(F1)
    expect(await read(F1, asked)).toBe('after asking')
  })

  it('a follower who leaves and asks again while a move is paused waits for approval instead of being moved', async () => {
    expect((await s.owner.privateFeedService.openFeed(P, keys[P])).success).toBe(true)
    const feed = (await s.owner.privateFeedService.getCurrentFeed(P, { fresh: true }))?.feed as number
    expect(await s.move.adoptUnfinishedMove(P)).toBeGreaterThan(0)
    const { loadMove } = await import('./private-feed-move-job')
    expect(loadMove(P)?.recipients).toContain(F1)
    expect(await s.follower.leave(P, F1)).toEqual({ success: true })
    expect(await s.follower.requestAccess(P, F1)).toEqual({ success: true })
    expect(await s.move.runMove(P, keys[P])).toEqual({ success: true })
    expect(grantsOf(P, feed)).not.toContain(F1)
    expect((await s.owner.privateFeedService.getPendingRequests(P)).map((r) => r.$ownerId)).toContain(F1)
  })

  it('a follower who leaves and asks again while their own grant is being written has that grant taken back', async () => {
    expect(await s.follower.requestAccess(P, F4)).toEqual({ success: true })
    await approveBy(P, F4)
    expect((await s.owner.privateFeedService.openFeed(P, keys[P])).success).toBe(true)
    expect(await s.move.adoptUnfinishedMove(P)).toBeGreaterThan(0)
    chain.afterGrant = async () => {
      const written = chain.docs.filter((doc) => doc.$type === 'privateFeedGrant').at(-1) as Record<string, unknown>
      expect(await s.follower.leave(P, F4)).toEqual({ success: true })
      expect(await s.follower.requestAccess(P, F4)).toEqual({ success: true })
      // Their new request landed before the grant did, after the move read their old one: the grant answered it.
      const asked = chain.docs.filter((doc) => doc.$type === 'followRequest' && doc.$ownerId === F4).at(-1) as Record<string, unknown>
      asked.$createdAt = (written.$createdAt as number) - 0.5
    }
    expect(await s.move.runMove(P, keys[P])).toEqual({ success: true })
    expect((await s.owner.privateFeedService.getPrivateFollowers(P)).map((f) => f.recipientId)).not.toContain(F4)
    // Fail closed: the take-back answers that request too, so they ask again.
    expect(await s.follower.getAccessStatus(P, F4)).toBe('revoked')
  })

  it('a follower blocked on another device during a move is not moved, even when their old grant could not be revoked', async () => {
    for (const follower of [F1, F5]) {
      expect(await s.follower.requestAccess(P, follower)).toEqual({ success: true })
    }
    await approveBy(P, F1, F5)
    expect((await s.owner.privateFeedService.openFeed(P, keys[P])).success).toBe(true)
    const feed = (await s.owner.privateFeedService.getCurrentFeed(P, { fresh: true }))?.feed as number
    expect(await s.move.adoptUnfinishedMove(P)).toBeGreaterThan(1)
    const { loadMove } = await import('./private-feed-move-job')
    const recipients = loadMove(P)?.recipients ?? []
    const later = recipients.at(-1) as string
    // The other device's block lands while the move runs; its revocation in the old feed does not (that feed's key changes are used up, say).
    const { blockService } = await import('./block-service')
    let blockedNow = false
    const getBlock = vi.spyOn(blockService, 'getBlock').mockImplementation(async (target, blocker) => (blockedNow && target === later && blocker === P ? ({ blockedId: later } as never) : null))
    chain.afterGrant = async () => {
      blockedNow = true
    }
    expect(await s.move.runMove(P, keys[P])).toEqual({ success: true })
    getBlock.mockRestore()
    const now = (await s.owner.privateFeedService.getPrivateFollowers(P)).map((f) => f.recipientId)
    expect(now).not.toContain(later)
    expect(now.length).toBeGreaterThan(0)
  })

  it('a renewal planned from a feed another device has renewed since is refused', async () => {
    const current = (await s.owner.privateFeedService.getCurrentFeed(P, { fresh: true }))?.feed as number
    expect(await s.owner.privateFeedService.openFeed(P, keys[P], { after: current - 1 })).toMatchObject({ success: false, errorCode: 'FEED_CHANGED' })
  })

  it('a saved move with everyone settled still finishes its clean-up', async () => {
    const current = (await s.owner.privateFeedService.getCurrentFeed(P, { fresh: true }))?.feed as number
    const { loadMove, saveMove } = await import('./private-feed-move-job')
    saveMove({ ownerId: P, from: current - 1, to: current, recipients: [], done: [], skipped: [], deleteOldGrants: false })
    expect(await s.move.adoptUnfinishedMove(P)).toBe(1)
    expect(await s.move.runMove(P, keys[P])).toEqual({ success: true })
    expect(loadMove(P)).toBeNull()
  })

  it('a removed follower still reads what was posted before the removal, caught up to just before it', async () => {
    for (const follower of [F4, F5]) expect(await s.follower.requestAccess(P, follower)).toEqual({ success: true })
    await approveBy(P, F4, F5)
    expect(await read(F5, await post('before', P))).toBe('before')
    expect(await s.owner.privateFeedService.revokeFollower(P, F4, keys[P])).toEqual({ success: true })
    const second = await post('after F4 left', P)
    expect(await s.owner.privateFeedService.revokeFollower(P, F5, keys[P])).toEqual({ success: true })
    // F5's keys stop one generation short of this post; catching up reaches it, then stops at F5's own removal.
    expect(await read(F5, second)).toBe('after F4 left')
    expect(await read(F5, await post('after F5 left', P))).toBe('<revoked>')
  })

  it('a private reply under a public root opens in the replier\'s own feed, whatever the card names as the root\'s owner', async () => {
    const sealed = await s.owner.prepareOwnerEncryption(P, 'my own reply', 'reply', undefined, keys[P])
    if (!sealed.success) throw new Error(sealed.error)
    vi.doMock('./post-service', () => ({ postService: { getPostById: async (id: string) => (id === 'public-root' ? { author: { id: O } } : null) } }))
    const reply = { author: { id: P }, targetKind: 'reply' as const, parentId: 'public-root', rootPostId: 'public-root', rootOwnerId: O, ...sealed.data }
    expect(await s.reader.privateFeedOwnerOf(reply, O)).toEqual({ owner: P, certain: true })
    expect(await s.reader.decryptPostOrReply(reply, P, keys[P], O)).toEqual({ outcome: { ok: true, text: 'my own reply' }, feedOwnerId: P })
    // Its root unreadable: the guess (the root owner it names) fails the content binding, and the replier's own feed opens it.
    const unread = { ...reply, parentId: 'lost-root', rootPostId: 'lost-root' }
    expect(await s.reader.privateFeedOwnerOf(unread, O)).toEqual({ owner: O, certain: false })
    expect(await s.reader.decryptPostOrReply(unread, P, keys[P], O)).toEqual({ outcome: { ok: true, text: 'my own reply' }, feedOwnerId: P })
    vi.doUnmock('./post-service')
  })

  it('a history link that misses a later key of its predecessor is refused, and one committed anyway keeps the old grants', async () => {
    const current = (await s.owner.privateFeedService.getCurrentFeed(P, { fresh: true }))?.feed as number
    const { fetchLatestKeyGeneration, fetchFeed } = await import('./private-feed-reads')
    const generation = await fetchLatestKeyGeneration(P, current)
    const stale = { feed: current, finalKeyGeneration: generation - 1, cek: new Uint8Array(32), history: new Uint8Array(32) }
    expect(await s.owner.privateFeedService.openFeed(P, keys[P], { carryFrom: stale })).toMatchObject({ success: false, errorCode: 'FEED_CHANGED' })

    for (const follower of [F1, F3]) await s.follower.requestAccess(P, follower)
    await approveBy(P, F1, F3)
    const oldFeed = await fetchFeed(P, current)
    if (!oldFeed) throw new Error('feed missing')
    const older = await post('before the renewal', P)
    let gap: PrivateContent | null = null
    const removedLeaf = chain.docs.find((doc) => doc.$type === 'privateFeedGrant' && doc.$ownerId === P && doc.feed === current && norm(doc.recipientId) === F5) as Record<string, unknown>
    chain.afterGrant = async () => {
      // Another device's removal in the old feed, ordered before the new feed was opened.
      expect((await s.owner.privateFeedService.revokeLeaf(P, oldFeed, removedLeaf.leafIndex as number, removedLeaf.keyGeneration as number, keys[P])).success).toBe(true)
      const rekey = chain.docs.filter((doc) => doc.$type === 'privateFeedRekey' && doc.$ownerId === P && doc.feed === current).at(-1) as Record<string, unknown>
      const opened = chain.docs.find((doc) => doc.$type === 'privateFeed' && doc.$ownerId === P && doc.feed === current + 1) as Record<string, unknown>
      rekey.$createdAt = (opened.$createdAt as number) - 0.5
      // ...and its post at that generation, which the link does not carry.
      const { cekAt, encryptContent } = await import('@/lib/private-feed/crypto')
      const { identifierToBytes } = await import('./sdk-helpers')
      const held = s.store.ownerKeys(P, current)
      if (!held) throw new Error('owner keys missing')
      const binding = { feedOwnerId: identifierToBytes(P), feed: current, keyGeneration: held.keyGeneration, authorId: identifierToBytes(P), kind: 'post' as const }
      const sealed = encryptContent(cekAt(held.seed, held.maxKeyGeneration, held.keyGeneration), 'in the gap', binding)
      gap = { feedOwnerId: P, feed: current, keyGeneration: held.keyGeneration, nonce: sealed.nonce, encryptedContent: sealed.ciphertext, authorId: P, kind: 'post' }
    }
    // Reported as a renewal without the history link: the copy says older posts stay with those who follow already.
    expect(await s.move.renewPrivateFeed(P, keys[P], { bringHistory: true })).toMatchObject({ success: true, historyLinked: false })
    expect(grantsOf(P, current + 1)).toEqual(expect.arrayContaining([F1, F3]))
    expect(grantsOf(P, current)).toEqual(expect.arrayContaining([F1, F3]))
    // A device that walked the link through this feed (to older posts) holds its history entry, which stops short of the gap:
    // the kept grant of that feed still opens the post in it.
    if (!gap) throw new Error('no post in the gap')
    const inGap: PrivateContent = gap
    s.store.clearIdentity(F3)
    s.store.storeHistoryKeys(F3, P, current, { finalKeyGeneration: inGap.keyGeneration - 1, cek: new Uint8Array(32), history: new Uint8Array(32) })
    expect(await read(F3, inGap)).toBe('in the gap')
    expect(await read(F3, older)).toBe('before the renewal')
  })

  it('the owner reads an old post through a feed whose seed this device kept, past the discovery window and a fresh start', async () => {
    expect(await s.owner.privateFeedService.enablePrivateFeed(F2, keys[F2])).toEqual({ success: true })
    const old = await post('from feed one', F2)
    expect(await s.move.renewPrivateFeed(F2, keys[F2], { bringHistory: true })).toMatchObject({ success: true, historyLinked: true })
    // Feed one's seed is gone from this device (sealed to a key it no longer has, say); feed two's stays.
    s.store.forgetOwnerKeys(F2, 1)
    for (let opened = 0; opened < 17; opened++) expect((await s.owner.privateFeedService.openFeed(F2, keys[F2])).success).toBe(true)
    const outcome = await s.reader.decryptPrivateContent(old, F2)
    expect(outcome).toEqual({ ok: true, text: 'from feed one' })
  })

  it('a follower who leaves and asks again while an earlier follower\'s grant is being written is not moved', async () => {
    expect((await s.owner.privateFeedService.openFeed(P, keys[P])).success).toBe(true)
    const feed = (await s.owner.privateFeedService.getCurrentFeed(P, { fresh: true }))?.feed as number
    expect(await s.move.adoptUnfinishedMove(P)).toBe(2)
    const { loadMove } = await import('./private-feed-move-job')
    const [first, second] = loadMove(P)?.recipients ?? []
    chain.afterGrant = async () => {
      expect(await s.follower.leave(P, second)).toEqual({ success: true })
      expect(await s.follower.requestAccess(P, second)).toEqual({ success: true })
    }
    expect(await s.move.runMove(P, keys[P])).toEqual({ success: true })
    expect(grantsOf(P, feed)).toEqual([first])
    expect((await s.owner.privateFeedService.getPendingRequests(P)).map((r) => r.$ownerId)).toContain(second)
  })
})

describe('private feeds v2: this device\'s key store', () => {
  it('drops the v1 layout\'s entries on load and keeps the current ones', async () => {
    const { scopedKey } = await import('@/lib/storage-scope')
    const { PrivateFeedKeyStore } = await import('./private-feed-key-store')
    const prefix = scopedKey('yappr:pf:')
    window.localStorage.setItem(prefix + 'feed_seed', 'legacy')
    window.localStorage.setItem(prefix + 'path_keys:' + O, 'legacy')
    new PrivateFeedKeyStore()
    expect(window.localStorage.getItem(prefix + 'feed_seed')).toBeNull()
    expect(window.localStorage.getItem(prefix + 'path_keys:' + O)).toBeNull()
    expect(s.store.ownerKeys(P, 1)).not.toBeNull()
  })

  it('stores nothing for an account signed out while work for it was still running', () => {
    const keys = { finalKeyGeneration: 1, cek: new Uint8Array(32).fill(1), history: new Uint8Array(32).fill(2) }
    s.store.signOut(F5)
    s.store.storeHistoryKeys(F5, O, 99, keys)
    expect(s.store.historyKeys(F5, O, 99)).toBeNull()
    s.store.signIn(F5)
    s.store.storeHistoryKeys(F5, O, 99, keys)
    expect(s.store.historyKeys(F5, O, 99)).not.toBeNull()
  })
})
