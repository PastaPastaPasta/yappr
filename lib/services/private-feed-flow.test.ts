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
  let rows = chain.docs.filter((doc) => doc.$type === q.documentTypeName && (q.where ?? []).every(([name, op, value]) => {
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
const [O, F1, F2, F3, F4, F5] = [ident(1), ident(2), ident(3), ident(4), ident(5), ident(6)]
const keys: Record<string, Uint8Array> = { [O]: secret(41), [F1]: secret(42), [F2]: secret(43), [F3]: secret(44), [F4]: secret(45), [F5]: secret(46) }

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

async function post(text: string): Promise<PrivateContent> {
  const sealed = await s.owner.prepareOwnerEncryption(O, text, 'post', undefined, keys[O])
  if (!sealed.success) throw new Error(sealed.error)
  return { feedOwnerId: O, feed: sealed.data.feed, keyGeneration: sealed.data.keyGeneration, nonce: sealed.data.nonce, encryptedContent: sealed.data.encryptedContent, authorId: O, kind: 'post' }
}

async function read(viewer: string, content: PrivateContent): Promise<string> {
  const outcome = await s.reader.decryptPrivateContent(content, viewer, keys[viewer])
  return outcome.ok ? outcome.text : `<${outcome.reason}>`
}

async function approve(...followers: string[]) {
  for (const follower of followers) {
    const result = await s.owner.privateFeedService.approveFollower(O, follower, getPublicKey(keys[follower]), keys[O])
    expect(result, follower).toEqual({ success: true })
  }
}

const grantsIn = (feed: number) => chain.docs.filter((doc) => doc.$type === 'privateFeedGrant' && doc.feed === feed).map((doc) => norm(doc.recipientId)).sort()

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
    expect(grantsIn(2)).toEqual([F1, F3].sort())
    expect(grantsIn(1)).toEqual([])
    posts.three = await post('three')
    expect(posts.three.feed).toBe(2)
    expect([await read(F1, posts.three), await read(F1, posts.one), await read(F2, posts.three)]).toEqual(['three', 'one', '<revoked>'])
    await s.follower.requestAccess(O, F4)
    await approve(F4)
    expect([await read(F4, posts.one), await read(F4, posts.two), await read(F4, posts.three)]).toEqual(['one', 'two', 'three'])
  })

  it('a fresh start keeps the old grants and gives newcomers nothing from before it', async () => {
    const renewed = await s.move.renewPrivateFeed(O, keys[O], { bringHistory: false })
    expect(renewed).toMatchObject({ success: true, historyLinked: false })
    expect(grantsIn(3)).toEqual([F1, F3, F4].sort())
    expect(grantsIn(2)).toEqual([F1, F3, F4].sort())
    posts.four = await post('four')
    await s.follower.requestAccess(O, F5)
    await approve(F5)
    expect([await read(F5, posts.four), await read(F5, posts.three)]).toEqual(['four', '<history-unavailable>'])
    expect([await read(F4, posts.four), await read(F4, posts.three)]).toEqual(['four', 'three'])
  })

  it('after the owner\'s key changes on a device without the old secret, renewing opens a feed with no history link', async () => {
    const rotated = secret(51)
    giveEncryptionKey(O, rotated, 3, [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data: bytesToBase64(getPublicKey(keys[O])), disabledAt: 1 }])
    keys[O] = rotated
    s.store.clearIdentity(O)
    expect((await s.owner.privateFeedService.getOverview(O))).toMatchObject({ keyRotated: true, hasSeed: false })
    expect(await s.move.canBringHistory(O, rotated)).toBe(false)
    const renewed = await s.move.renewPrivateFeed(O, rotated, { bringHistory: true })
    expect(renewed).toMatchObject({ success: true, historyLinked: false })
    expect((await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true }))).toMatchObject({ feed: 4, keyId: 3 })
    expect(grantsIn(3)).toEqual([F1, F3, F4, F5].sort())
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
    expect(grantsIn(5)).not.toContain(F3)
    expect(grantsIn(5)).toContain(F1)
    expect(await s.follower.getAccessStatus(O, F3)).toBe('none')
  })

  it('a reply under an old private post goes into the owner\'s current feed, readable by its members only', async () => {
    const sealed = await s.owner.prepareInheritedEncryption('a reply', { ownerId: O }, F1)
    if (!sealed.success) throw new Error(sealed.error)
    const current = await s.owner.privateFeedService.getCurrentFeed(O, { fresh: true })
    expect(sealed.data.feed).toBe(current?.feed)
    const reply: PrivateContent = { feedOwnerId: O, feed: sealed.data.feed, keyGeneration: sealed.data.keyGeneration, nonce: sealed.data.nonce, encryptedContent: sealed.data.encryptedContent, authorId: F1, kind: 'reply' }
    expect([await read(O, reply), await read(F4, reply), await read(F3, reply), await read(F2, reply)]).toEqual(['a reply', 'a reply', '<no-access>', '<revoked>'])
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
})
