/**
 * `privateFeed` (api/private-feed.ts) on social v17, without a network: the
 * engine's reads and write tickets over lib's real owner, follower, reader
 * and move services, against an in-memory chain that keeps the contract's
 * unique indexes and its follow-request and feed references (the same fake
 * as lib/services/private-feed-flow.test.ts). One scenario walks the flow
 * the app offers: enable, request, approve, read decrypted, revoke, and a
 * removed follower who cannot read what comes after; the rest pin the
 * locked states, the ticket mapping and the network gate.
 */
import bs58 from 'bs58'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from '@/lib/crypto/keys'
import { bytesToBase64 } from '@/lib/bytes'
import type { Post } from '@/lib/types'

const chain = vi.hoisted(() => ({
  docs: [] as Record<string, unknown>[],
  clock: 1_000,
  ids: 0,
  identities: new Map<string, { publicKeys: Record<string, unknown>[] }>(),
  /** Each account's messaging key on this device (lib's `getEncryptionKeyBytes`). */
  session: new Map<string, Uint8Array>(),
  /** Accounts signed in through a wallet (App Connect). */
  wallet: new Set<string>(),
  viewer: null as string | null,
  supported: true,
  follows: new Set<string>(),
  /** The next delete fails as a timeout would (lib returns it as an unclassified failure). */
  failNextDelete: false,
  /** Creates of these types land, but report themselves unconfirmed (a confirmation wait that timed out). */
  unconfirmedTypes: new Set<string>(),
}))

type Doc = Record<string, unknown> & { $id: string; $ownerId: string; $type: string; $createdAt: number }

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

const refuse = (error: string) => ({ success: false, error })

async function createDocument(_contract: string, type: string, ownerId: string, data: Record<string, unknown>) {
  const doc: Doc = { ...data, $id: bs58.encode(new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? ++chain.ids % 256 : i === 1 ? chain.ids >> 8 : 9))), $ownerId: ownerId, $type: type, $createdAt: ++chain.clock, $revision: 1 }
  for (const index of UNIQUE[type] ?? []) {
    if (chain.docs.some((other) => other.$type === type && index.every((name) => field(other, name) === field(doc, name)))) {
      return refuse(`Document ${doc.$id} has duplicate unique properties ${JSON.stringify(index)} (code 40105)`)
    }
  }
  if (type === 'privateFeedGrant' || type === 'privateFeedRekey') {
    const feed = chain.docs.find((other) => other.$type === 'privateFeed' && other.$ownerId === ownerId && other.feed === data.feed)
    if (!feed) return refuse('referenced permanent document privateFeed not found for path $ownerId (code 40120)')
  }
  if (type === 'privateFeedGrant') {
    const asked = chain.docs.some((other) => other.$type === 'followRequest' && other.$ownerId === norm(data.recipientId) && field(other, 'targetId') === ownerId)
    if (!asked) return refuse('referenced deletable document followRequest not found for path recipientId (code 40120)')
  }
  chain.docs.push(doc)
  return { success: true, document: doc, transactionHash: doc.$id, ...(chain.unconfirmedTypes.has(type) ? { confirmed: false } : {}) }
}

async function deleteDocument(_contract: string, type: string, id: string, ownerId: string) {
  if (chain.failNextDelete) {
    chain.failNextDelete = false
    return refuse('Request timed out')
  }
  if (type === 'privateFeed' || type === 'privateFeedRekey') return refuse(`documents of type ${type} can not be deleted (code 10404)`)
  const index = chain.docs.findIndex((doc) => doc.$id === id && doc.$ownerId === ownerId)
  if (index < 0) return refuse('not found')
  chain.docs.splice(index, 1)
  return { success: true }
}

vi.mock('@/lib/services/evo-sdk-service', () => ({
  getEvoSdk: async () => ({ documents: { query: async (q: Parameters<typeof query>[0]) => query(q) } }),
  evoSdkService: { isConnectionError: () => false },
}))
vi.mock('@/lib/services/state-transition-service', () => ({ stateTransitionService: { createDocument, deleteDocument } }))
vi.mock('@/lib/services/identity-service', () => ({
  identityService: { getIdentity: async (id: string) => chain.identities.get(id) ?? null, clearCache: () => undefined },
}))
vi.mock('@/lib/secure-storage', async (load) => ({ ...await load<object>(), getEncryptionKeyBytes: (id: string) => chain.session.get(id) ?? null }))
vi.mock('@/lib/app-connect/memory-keys', async (load) => ({ ...await load<object>(), hasAppConnectSession: (id: string) => chain.wallet.has(id) }))
vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => chain.viewer }))
/** Stands in for lib's `renewPrivateFeed` while set (given the real one), so a test can pause the move after it. */
const moveHooks = vi.hoisted(() => ({ renew: null as null | ((renew: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]) => Promise<unknown>) }))
vi.mock('@/lib/services/private-feed-move', async (load) => {
  const actual = await load<{ renewPrivateFeed: (...args: unknown[]) => Promise<unknown> }>()
  return {
    ...actual,
    renewPrivateFeed: (...args: unknown[]) => (moveHooks.renew ? moveHooks.renew(actual.renewPrivateFeed, ...args) : actual.renewPrivateFeed(...args)),
  }
})
vi.mock('@/lib/contract-topology', async (load) => {
  const actual = await load<{ privateFeedClientSupported: () => boolean }>()
  return { ...actual, privateFeedClientSupported: () => chain.supported && actual.privateFeedClientSupported() }
})
vi.mock('@/lib/services/follow-service', () => ({
  followService: {
    isFollowing: async (target: string, follower: string) => chain.follows.has(`${follower}>${target}`),
    followUser: async (follower: string, target: string) => {
      chain.follows.add(`${follower}>${target}`)
      return { success: true }
    },
    getFollowStatusBatch: async (ids: string[]) => new Map(ids.map(id => [id, false])),
  },
}))
vi.mock('@/lib/services/block-service', () => ({ blockService: { getUserBlocks: async () => [], getBlock: async () => null } }))
vi.mock('@/lib/services/identity-batch', () => ({ loadIdentityBatch: async (ids: string[]) => ({ usernames: new Map(ids.map(id => [id, null])), profiles: [], avatars: new Map() }) }))

/** The key store, the move job and the requests answered, as a browser's Web Storage. */
const items = new Map<string, string>()
Object.assign(globalThis, {
  window: globalThis,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  localStorage: {
    get length() { return items.size },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v) },
    removeItem: (k: string) => { items.delete(k) },
    clear: () => items.clear(),
  },
})

const ident = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const secret = (n: number) => new Uint8Array(32).fill(n)
const [O, F, G] = [ident(1), ident(2), ident(3)]
const keys: Record<string, Uint8Array> = { [O]: secret(41), [F]: secret(42), [G]: secret(43) }

type Api = typeof import('../../src/api/private-feed')
type WriteTicket = import('../../src/writes/types').WriteTicket
let api: Api
let tickets: ReturnType<typeof import('../../src/writes/tickets')['createTicketStore']>
let writes: ReturnType<Api['createPrivateFeedWrites']>
let owner: typeof import('@/lib/services/private-feed-service')
let remember: typeof import('../../src/dto/private-content')['rememberPrivatePost']

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v17')
  for (const [id, key] of Object.entries(keys)) {
    chain.identities.set(id, { publicKeys: [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data: bytesToBase64(getPublicKey(key)) }] })
    chain.session.set(id, key)
  }
  api = await import('../../src/api/private-feed')
  owner = await import('@/lib/services/private-feed-service')
  remember = (await import('../../src/dto/private-content')).rememberPrivatePost
  const { createTicketStore } = await import('../../src/writes/tickets')
  const stored = new Map<string, string>()
  tickets = createTicketStore({
    storage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) } },
    emit: () => undefined,
    currentIdentity: () => chain.viewer,
    documentExists: async () => true,
    absenceRecheckMs: 0,
    autoRetryDelaysMs: [],
  })
  writes = api.createPrivateFeedWrites(tickets)
})

beforeEach(() => {
  chain.supported = true
})

const as = (viewer: string | null) => { chain.viewer = viewer }

/** A write's ticket once its background run has settled. */
async function settle(submitted: Promise<WriteTicket>): Promise<WriteTicket> {
  const { id } = await submitted
  return vi.waitFor(() => {
    const ticket = tickets.get(id)
    if (!ticket || ticket.state === 'pending') throw new Error('still pending')
    return ticket
  }, { timeout: 10_000, interval: 5 })
}

let posts = 0
/** A private post by `author` as the engine hands it to the host, with its ciphertext remembered. */
async function privatePost(author: string, text: string): Promise<string> {
  const sealed = await owner.prepareOwnerEncryption(author, text, 'post', undefined, keys[author])
  if (!sealed.success) throw new Error(sealed.error)
  const id = bs58.encode(new Uint8Array(32).fill(200 + ++posts))
  const post: Post = {
    id, author: { id: author, username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) },
    content: '', createdAt: new Date(), likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0,
    encryptedContent: sealed.data.encryptedContent, nonce: sealed.data.nonce, keyGeneration: sealed.data.keyGeneration, feed: sealed.data.feed,
  }
  remember(post)
  return id
}

describe('privateFeed: owner enables, follower requests, owner approves, posts, revokes', () => {
  let before: string

  it('shows the owner a feed that is off, then turns it on with the messaging key', async () => {
    as(O)
    chain.wallet.add(O)
    expect(await api.privateFeedReads.overview()).toEqual({ enabled: false, messagingKey: 'ready', capacity: 4096 })
    expect((await settle(writes.enable())).state).toBe('confirmed')
    expect(await api.privateFeedReads.overview()).toMatchObject({
      enabled: true, followers: 0, capacity: 4096, removals: 0, maxRemovals: 4094, keyRotated: false, nearlyFull: false, move: null,
    })
    expect(await api.privateFeedReads.access(O)).toEqual({ hasFeed: true, status: 'self', messagingKey: 'ready' })
  })

  it('keeps a private post from someone who has not asked, and offers the request', async () => {
    before = await privatePost(O, 'from before anyone followed')
    as(F)
    expect(await api.privateFeedReads.read(before)).toMatchObject({ state: 'locked', reason: 'none', feedOwnerId: O, own: false })
    expect(await api.privateFeedReads.access(O)).toEqual({ hasFeed: true, status: 'none', messagingKey: 'ready' })
  })

  it('sends the request, following the owner first, and shows it pending to both sides', async () => {
    as(F)
    expect((await settle(writes.request(O))).state).toBe('confirmed')
    expect(chain.follows.has(`${F}>${O}`)).toBe(true)
    expect((await api.privateFeedReads.access(O)).status).toBe('pending')
    expect(await api.privateFeedReads.read(before)).toMatchObject({ state: 'locked', reason: 'pending' })
    as(O)
    expect((await api.privateFeedReads.requests()).map(request => ({ id: request.user.id, renewal: request.renewal }))).toEqual([{ id: F, renewal: false }])
  })

  it('approves the request; the follower then reads every private post decrypted, the older one included', async () => {
    as(O)
    expect((await settle(writes.approve(F))).state).toBe('confirmed')
    expect(await api.privateFeedReads.requests()).toEqual([])
    expect((await api.privateFeedReads.followers()).map(follower => follower.user.id)).toEqual([F])
    const after = await privatePost(O, 'for my followers')
    as(F)
    expect(await api.privateFeedReads.read(after)).toEqual({ state: 'open', text: 'for my followers', feedOwnerId: O, own: false, followerCount: null })
    expect(await api.privateFeedReads.read(before)).toMatchObject({ state: 'open', text: 'from before anyone followed' })
    expect((await api.privateFeedReads.access(O)).status).toBe('approved')
    as(O)
    expect(await api.privateFeedReads.read(after)).toEqual({ state: 'open', text: 'for my followers', feedOwnerId: O, own: true, followerCount: 1 })
  })

  it('revokes the follower: what comes after stays locked to them, what they read before still opens', async () => {
    as(O)
    const kept = await privatePost(O, 'before the removal')
    expect((await settle(writes.revoke(F))).state).toBe('confirmed')
    expect(await api.privateFeedReads.followers()).toEqual([])
    expect(await api.privateFeedReads.overview()).toMatchObject({ followers: 0, removals: 1 })
    const later = await privatePost(O, 'after the removal')
    as(F)
    expect(await api.privateFeedReads.read(kept)).toMatchObject({ state: 'open', text: 'before the removal' })
    expect(await api.privateFeedReads.read(later)).toMatchObject({ state: 'locked', reason: 'revoked', feedOwnerId: O })
    expect((await api.privateFeedReads.access(O)).status).toBe('revoked')
  })

  it('lets the removed follower ask again, and withdraw it', async () => {
    as(F)
    expect((await settle(writes.request(O))).state).toBe('confirmed')
    expect((await api.privateFeedReads.access(O)).status).toBe('pending')
    as(O)
    expect((await api.privateFeedReads.requests()).map(request => request.user.id)).toEqual([F])
    as(F)
    expect((await settle(writes.leave(O))).state).toBe('confirmed')
    expect((await api.privateFeedReads.access(O)).status).toBe('revoked')
  })
})

describe('privateFeed: locked states and refusals', () => {
  it('asks a signed-out viewer to sign in', async () => {
    as(O)
    const id = await privatePost(O, 'members only')
    as(null)
    expect(await api.privateFeedReads.read(id)).toMatchObject({ state: 'locked', reason: 'signed-out', feedOwnerId: O })
  })

  it('says the messaging key is missing, and how to get it, for an approved follower without it here', async () => {
    as(G)
    expect((await settle(writes.request(O))).state).toBe('confirmed')
    as(O)
    expect((await settle(writes.approve(G))).state).toBe('confirmed')
    const id = await privatePost(O, 'needs the key')
    as(G)
    chain.session.delete(G)
    chain.wallet.add(G)
    try {
      expect(await api.privateFeedReads.read(id)).toMatchObject({ state: 'locked', reason: 'needs-key', messagingKey: 'allow-in-wallet' })
      chain.wallet.delete(G)
      expect(await api.privateFeedReads.read(id)).toMatchObject({ state: 'locked', reason: 'needs-key', messagingKey: 'unavailable' })
      // A write that needs the key fails before anything is sent.
      as(G)
      const ticket = await settle(writes.enable())
      expect(ticket.state).toBe('failed')
      expect(ticket.error).toMatchObject({ code: 'NO_MESSAGING_KEY', outcome: 'local' })
    } finally {
      chain.session.set(G, keys[G])
    }
    expect(await api.privateFeedReads.read(id)).toMatchObject({ state: 'open', text: 'needs the key' })
  })

  it("fails an approval of a request that was withdrawn with the feed's own sentence", async () => {
    as(O)
    const ticket = await settle(writes.approve(F))
    expect(ticket.state).toBe('failed')
    expect(ticket.error).toMatchObject({ code: 'PRIVATE_FEED', userMessage: 'This person withdrew their request, so there is nothing to approve.' })
  })

  it('refuses member writes about the viewer themselves', async () => {
    as(O)
    await expect(writes.approve(O)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(writes.request(O)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('offers nothing where the network has no private feeds', async () => {
    as(O)
    const id = await privatePost(O, 'on v17')
    chain.supported = false
    expect(await api.privateFeedReads.read(id)).toMatchObject({ state: 'locked', reason: 'unsupported' })
    expect(await api.privateFeedReads.access(F)).toEqual({ hasFeed: false, status: 'none', messagingKey: 'ready' })
    await expect(api.privateFeedReads.overview()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(writes.enable()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })

  it('checks private drafts before a ticket: one part, a teaser when asked for, and never kept on disk', async () => {
    const { draftIsPrivate, validateDraft } = await import('../../src/writes/publish')
    expect(() => validateDraft({ parts: [{ text: 'one' }, { text: 'two' }], visibility: 'private' })).toThrow('A private post cannot be a thread')
    expect(() => validateDraft({ parts: [{ text: 'body' }], visibility: 'private-with-teaser' })).toThrow('needs the teaser text')
    expect(() => validateDraft({ parts: [{ text: 'body' }], visibility: 'private-with-teaser', teaser: 'x'.repeat(281) })).toThrow('at most 280')
    expect(() => validateDraft({ parts: [{ text: 'body' }], visibility: 'secret' as never })).toThrow('visibility is one of')
    expect(() => validateDraft({ parts: [{ text: 'body' }], visibility: 'private-with-teaser', teaser: 'see more' })).not.toThrow()
    expect(draftIsPrivate({ parts: [{ text: 'body' }], visibility: 'private' })).toBe(true)
    expect(draftIsPrivate({ parts: [{ text: 'body' }] })).toBe(false)
    // A reply to a private post the engine has shown is private too: its text inherits the thread's encryption.
    as(O)
    const id = await privatePost(O, 'a private thread')
    expect(draftIsPrivate({ parts: [{ text: 'reply' }], replyTo: { id, kind: 'post', ownerId: O, rootPostId: null } })).toBe(true)
    // So is a reply the host marks as one (to a private post the engine has not shown), and one compose showed as private.
    const unseen = { id: 'unseen-private-post', kind: 'post' as const, ownerId: O, rootPostId: null }
    expect(draftIsPrivate({ parts: [{ text: 'reply' }], replyTo: unseen })).toBe(false)
    expect(draftIsPrivate({ parts: [{ text: 'reply' }], replyTo: unseen, replyToPrivate: true })).toBe(true)
    expect(draftIsPrivate({ parts: [{ text: 'reply' }], replyTo: unseen, expectInherited: true })).toBe(true)
    chain.supported = false
    expect(() => validateDraft({ parts: [{ text: 'body' }], visibility: 'private' })).toThrow('not available on this network')
  })

  it("says whether a reply to a private post is private: only in a private thread", async () => {
    as(O)
    const id = await privatePost(O, 'a private root')
    // A root post: its own thread is private (getEncryptionSource reads the root by id).
    const { postService } = await import('@/lib/services/post-service')
    const { privatePostOf } = await import('../../src/dto/private-content')
    const root = privatePostOf(id)
    const getPostById = vi.spyOn(postService, 'getPostById').mockResolvedValue(root as never)
    try {
      expect(await api.privateFeedReads.replySource(id)).toEqual({ private: true })
      getPostById.mockResolvedValue({ ...root, encryptedContent: undefined } as never)
      expect(await api.privateFeedReads.replySource(id)).toEqual({ private: false })
    } finally {
      getPostById.mockRestore()
    }
  })

  it('leaves a request and an approval that landed unconfirmed to their checks, which find them', async () => {
    chain.unconfirmedTypes = new Set(['followRequest', 'privateFeedGrant'])
    // Real times: the request's check compares its $createdAt with the ticket's.
    chain.clock = Math.max(chain.clock, Date.now())
    try {
      as(G)
      const request = await settle(writes.request(O))
      expect(request).toMatchObject({ state: 'unconfirmed' })
      const checked = await tickets.check(request.id)
      expect(checked).toMatchObject({ state: 'confirmed' })
      as(O)
      const approval = await settle(writes.approve(G))
      expect(approval.state).toBe('unconfirmed')
      expect(await tickets.check(approval.id)).toMatchObject({ state: 'confirmed' })
    } finally {
      chain.unconfirmedTypes = new Set()
    }
  })

  it('never confirms Ask again by the request it was replacing', async () => {
    // Real times: the request's check compares its $createdAt with the ticket's.
    chain.clock = Math.max(chain.clock, Date.now())
    as(G)
    expect((await settle(writes.request(O))).state).toBe('confirmed')
    // Asked again at once: lib deletes the standing request first, and that delete times out.
    chain.failNextDelete = true
    const again = await settle(writes.request(O))
    expect(again.state).not.toBe('confirmed')
    expect((await tickets.check(again.id)).state).not.toBe('confirmed')
    // Tidy: withdraw what still stands, for the tests after this one.
    await settle(writes.leave(O))
  })

  it('never confirms a re-approval by the grant it was replacing', async () => {
    as(G)
    expect((await settle(writes.request(O))).state).toBe('confirmed')
    as(O)
    expect((await settle(writes.approve(G))).state).toBe('confirmed')
    // G asks again (a new messaging key): their request now postdates the grant they hold.
    const request = chain.docs.find((doc) => doc.$type === 'followRequest' && doc.$ownerId === G)
    expect(request).toBeDefined()
    if (request) request.$createdAt = ++chain.clock
    // lib replaces the old grant; its delete times out, so the approval is unconfirmed.
    chain.failNextDelete = true
    const ticket = await settle(writes.approve(G))
    expect(ticket.state).toBe('unconfirmed')
    expect((await tickets.check(ticket.id)).state).not.toBe('confirmed')
  })

  it('checks a removal again by the feeds a removal rekeys', async () => {
    as(G)
    expect((await settle(writes.request(O))).state).toBe('confirmed')
    as(O)
    expect((await settle(writes.approve(G))).state).toBe('confirmed')
    const ticket = await settle(writes.revoke(G))
    expect(ticket.state).toBe('confirmed')
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
  })

  it('estimates a renewal that brings older posts along', async () => {
    as(O)
    expect(await api.privateFeedReads.renewal()).toMatchObject({ followers: 0, canBringHistory: 'yes' })
  })

  it('confirms a renewal whose new feed landed though the move after it paused, and never one that did not land', async () => {
    as(O)
    try {
      moveHooks.renew = async (renew, ...args) => {
        await renew(...args)
        return { success: false, error: 'The move paused.' }
      }
      expect((await settle(writes.renew({ bringHistory: false }))).state).toBe('confirmed')

      // Nothing landed (a timeout opening the feed): not confirmed, and not one of the feed's refusals.
      moveHooks.renew = async () => ({ success: false, error: 'Timed out opening your private feed' })
      const missed = await settle(writes.renew({ bringHistory: false }))
      expect(missed.state).not.toBe('confirmed')
      expect(missed.error).not.toMatchObject({ code: 'PRIVATE_FEED' })
    } finally {
      moveHooks.renew = null
    }
  })
})
