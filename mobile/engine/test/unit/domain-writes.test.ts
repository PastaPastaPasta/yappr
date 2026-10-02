/**
 * The domain writes (M7b) with lib's services mocked: each write's ticket
 * mapping (ENGINE.md §7.1), its topology branches, its input checks and its
 * "check again" probe. `publishThread` and `planPosts` run for real, so the
 * thread tests also pin the engine's reading of lib's chaining.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Post } from '@/lib/types'

// publishThread dispatches window events (content.created); Node's globalThis is not an EventTarget.
const events = new EventTarget()
Object.assign(globalThis, {
  window: globalThis,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
})
// The engine's Web Storage (the notification store persists its read state).
const kv = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => kv.get(key) ?? null,
    setItem: (key: string, value: string) => { kv.set(key, value) },
    removeItem: (key: string) => { kv.delete(key) },
  },
})

const m = vi.hoisted(() => ({
  viewer: 'V' as string | null,
  topology: {} as Record<string, boolean>,
  unconfirmed: new Set<string>(),
  settle: vi.fn(async () => true),
  documentExists: vi.fn(async () => true),
  imageDigest: vi.fn(),
  strict: { likeExists: vi.fn(), ownQuoteStrict: vi.fn(), repostExists: vi.fn(), ownBlockExists: vi.fn() },
  likeService: { likePost: vi.fn(), unlikePost: vi.fn(), isLiked: vi.fn() },
  bookmarkService: { bookmarkPost: vi.fn(), removeBookmark: vi.fn(), getBookmark: vi.fn(), getUserBookmarks: vi.fn() },
  repostService: { repostPost: vi.fn(), removeRepost: vi.fn(), isReposted: vi.fn() },
  postService: {
    createPost: vi.fn(), deleteOwnPost: vi.fn(), getOwnQuotes: vi.fn(), getPostById: vi.fn(),
    getPostsByIdsForDisplay: vi.fn(), enrichPostsBatch: vi.fn(async (posts: unknown[]) => posts),
  },
  replyService: { createReply: vi.fn(), deleteOwnReply: vi.fn(), getReplyById: vi.fn() },
  followService: { followUser: vi.fn(), unfollowUser: vi.fn(), getFollowing: vi.fn(), getFollowStatusBatch: vi.fn(async () => new Map()) },
  blockService: {
    blockUser: vi.fn(), unblockUser: vi.fn(), getBlockProvenance: vi.fn(), query: vi.fn(), checkBlockedBatch: vi.fn(), getBlockSourcesBatch: vi.fn(),
  },
  reportService: { fileReport: vi.fn(), getOwnReport: vi.fn() },
  profileService: { updateProfile: vi.fn(), getProfile: vi.fn(), profileExists: vi.fn(), getStoredAvatar: vi.fn() },
  hashtagService: { createPostHashtags: vi.fn(async () => []) },
  notificationService: { getInitialNotifications: vi.fn(), pollNewNotifications: vi.fn() },
}))

const FLAGS = ['repostsAreQuotes', 'deletesAreTombstones', 'contractTakesReports', 'mediaCarriesHashes', 'hashtagsAreInline', 'mentionsAreInline']
vi.mock('@/lib/contract-topology', async (load) => {
  const actual = await load<Record<string, unknown>>()
  return {
    ...actual,
    ...Object.fromEntries(FLAGS.map(flag => [flag, () => m.topology[flag] === true])),
    canRepost: (kind: string) => m.topology[`repost:${kind}`] !== false,
    canBookmark: (kind: string) => m.topology[`bookmark:${kind}`] !== false,
  }
})
vi.mock('@/lib/services/sdk-helpers', async (load) => ({ ...await load<object>(), getCurrentUserId: () => m.viewer }))
vi.mock('@/lib/unconfirmed-writes', () => ({
  isUnconfirmed: (id?: string) => Boolean(id && m.unconfirmed.has(id)),
  markUnconfirmed: (_type: string, id: string) => { m.unconfirmed.add(id) },
  settleUnconfirmed: m.settle,
}))
vi.mock('@/lib/media/image-digest', () => ({ imageDigestForUrl: m.imageDigest }))
vi.mock('../../src/writes/strict-reads', () => m.strict)
// One attempt per part: lib's backoff between retries is not what these tests pin.
vi.mock('@/lib/retry-utils', () => ({
  retryPostCreation: async (operation: () => Promise<unknown>) => {
    try {
      return { success: true, data: await operation(), attempts: 1 }
    } catch (error) {
      return { success: false, error, attempts: 1 }
    }
  },
}))
vi.mock('@/lib/services/like-service', () => ({ likeService: m.likeService }))
vi.mock('@/lib/services/bookmark-service', () => ({ bookmarkService: m.bookmarkService }))
vi.mock('@/lib/services/repost-service', () => ({ repostService: m.repostService }))
vi.mock('@/lib/services/post-service', async (load) => ({ ...await load<object>(), postService: m.postService }))
vi.mock('@/lib/services/reply-service', async (load) => ({ ...await load<object>(), replyService: m.replyService }))
vi.mock('@/lib/services/follow-service', () => ({ followService: m.followService }))
vi.mock('@/lib/services/block-service', () => ({ blockService: m.blockService }))
vi.mock('@/lib/services/report-service', () => ({ reportService: m.reportService }))
vi.mock('@/lib/services/hashtag-service', () => ({ hashtagService: m.hashtagService }))
vi.mock('@/lib/services/notification-service', () => ({ notificationService: m.notificationService }))
vi.mock('@/lib/services/unified-profile-service', async (load) => {
  const actual = await load<{ unifiedProfileService: { encodeAvatarData: (seed: string, style: string) => string } }>()
  return {
    ...actual,
    unifiedProfileService: {
      ...m.profileService,
      encodeAvatarData: actual.unifiedProfileService.encodeAvatarData,
      getProfilesByIdentityIds: async () => [],
    },
  }
})
vi.mock('@/lib/services/identity-batch', () => ({ loadIdentityBatch: async () => ({ usernames: new Map(), profiles: [], avatars: new Map() }) }))

const { createTicketStore } = await import('../../src/writes/tickets')
const { createEngageWrites } = await import('../../src/api/engage')
const { createGraphWrites } = await import('../../src/api/graph')
const { createPostWrites } = await import('../../src/api/posts')
const { createProfileWrites } = await import('../../src/api/profiles')
const { createSafetyModule } = await import('../../src/api/safety')
const { createNotificationsModule } = await import('../../src/api/notifications')
const { useSettingsStore } = await import('@/lib/store')
const { useNotificationStore } = await import('@/lib/stores/notification-store')
const { ListLimitError } = await import('@/lib/typed-array-codecs')
const { YAPPR_CONTRACT_ID } = await import('@/lib/constants')
const { validate, page, postDTO, notificationDTO, blockedUserDTO } = await import('../../src/dto/validate')
type WriteTicket = import('../../src/writes/types').WriteTicket

/** A 44-character base58 id. */
const id = (tag: string) => tag.replace(/[0OIl]/g, 'z').padEnd(44, 'x')
const VIEWER = id('Viewer')
const AUTHOR = id('Author')
const TARGET = { id: id('Target'), kind: 'post' as const, ownerId: AUTHOR, rootPostId: null }
const user = (userId: string) => ({ id: userId, username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) })
const post = (postId: string, extra: Partial<Post> = {}): Post => ({
  id: postId, author: user(AUTHOR), content: 'hi', createdAt: new Date(1000), likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0, ...extra,
})

let emitted: { event: string; payload: unknown }[] = []
const emit = (event: string, payload: unknown) => { emitted.push({ event, payload }) }

function storage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) } }
}

function engine() {
  const tickets = createTicketStore({
    storage: storage(), emit, currentIdentity: () => m.viewer, documentExists: m.documentExists, absenceRecheckMs: 0,
  })
  return {
    tickets,
    /** A write's ticket once its background run has settled. */
    outcome: (submitted: Promise<WriteTicket>) => submitted.then(ticket => settled(tickets, ticket.id)),
    engage: createEngageWrites(tickets),
    graph: createGraphWrites(tickets),
    posts: createPostWrites(tickets, emit),
    profiles: createProfileWrites(tickets),
    safety: createSafetyModule(tickets),
  }
}

/** The ticket once its background run has settled (publishThread's first dynamic imports take a while). */
function settled(store: ReturnType<typeof engine>['tickets'], ticketId: string) {
  return vi.waitFor(() => {
    const ticket = store.get(ticketId)
    if (!ticket || ticket.state === 'pending') throw new Error('still pending')
    return ticket
  }, { timeout: 10_000, interval: 5 })
}

const stagesOf = (ticketId: string) => emitted
  .filter(e => e.event === 'write.status' && (e.payload as { id: string }).id === ticketId)
  .map(e => (e.payload as { stage: string | null }).stage)

beforeEach(() => {
  vi.clearAllMocks()
  m.viewer = VIEWER
  m.topology = { hashtagsAreInline: true, mentionsAreInline: true, contractTakesReports: true }
  m.unconfirmed.clear()
  m.settle.mockResolvedValue(true)
  m.documentExists.mockResolvedValue(true)
  emitted = []
})

describe('engage writes', () => {
  it('likes after settling an unconfirmed target, and maps lib\'s boolean', async () => {
    const { tickets, outcome, engage } = engine()
    m.unconfirmed.add(TARGET.id)
    m.likeService.likePost.mockResolvedValue(true)
    const ticket = await engage.like(TARGET)
    expect(ticket).toMatchObject({ op: 'like', state: 'pending', identityId: VIEWER, target: TARGET })
    expect(await settled(tickets, ticket.id)).toMatchObject({ state: 'confirmed' })
    expect(m.settle).toHaveBeenCalledWith(TARGET.id)
    expect(m.likeService.likePost).toHaveBeenCalledWith(TARGET.id, VIEWER, AUTHOR, 'post', { author: AUTHOR })
    // waiting-parent is left before lib's write, so a transport failure there is never "proved not sent".
    expect(stagesOf(ticket.id)).toEqual(['queued', 'waiting-parent', 'signing', null])

    // lib's boolean `false` carries no verdict (it swallows the error): it may have landed.
    m.likeService.likePost.mockResolvedValue(false)
    expect(await outcome(engage.like(TARGET))).toMatchObject({ state: 'unconfirmed', retryable: false, error: { code: 'UNKNOWN', outcome: 'unknown' } })
  })

  it('refuses to name a target that never confirmed: PARENT_UNCONFIRMED, nothing sent', async () => {
    const { outcome, engage } = engine()
    m.unconfirmed.add(TARGET.id)
    m.settle.mockResolvedValue(false)
    const ticket = await outcome(engage.bookmark(TARGET))
    expect(ticket).toMatchObject({ state: 'failed', error: { code: 'PARENT_UNCONFIRMED', outcome: 'local' } })
    expect(m.bookmarkService.bookmarkPost).not.toHaveBeenCalled()
  })

  it('treats a transport failure inside lib\'s write as "may have landed", and checks it with a relation read', async () => {
    const { tickets, outcome, engage } = engine()
    m.likeService.likePost.mockRejectedValue(new Error('Network request failed: connection reset'))
    const ticket = await outcome(engage.like(TARGET))
    expect(ticket).toMatchObject({ state: 'unconfirmed', error: { code: 'NETWORK', outcome: 'unknown' }, retryable: false })
    m.strict.likeExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
    expect(m.strict.likeExists).toHaveBeenCalledTimes(2)
    expect(m.strict.likeExists).toHaveBeenCalledWith(VIEWER, TARGET.id, 'post')

    // A failed read proves nothing, even for an undo that expects "absent".
    m.likeService.unlikePost.mockRejectedValue(new Error('Request timeout'))
    const unlike = await outcome(engage.unlike(TARGET))
    m.strict.likeExists.mockRejectedValue(new Error('read failed'))
    expect(await tickets.check(unlike.id)).toMatchObject({ state: 'unconfirmed', retryable: false })
  })

  it('v10: reposts as a bare quote post, and recovers its own slot from a 40105', async () => {
    const { outcome, engage } = engine()
    m.topology.repostsAreQuotes = true
    m.postService.createPost.mockResolvedValue({ ...post(id('Bare')), __createConfirmed: false })
    const first = await outcome(engage.repost(TARGET))
    expect(m.postService.createPost).toHaveBeenCalledWith(VIEWER, '', { quotedPostId: TARGET.id, quotedPostOwnerId: AUTHOR })
    expect(first).toMatchObject({ state: 'unconfirmed', documents: [{ type: 'post', id: id('Bare'), action: 'create', confirmed: false }] })

    const duplicate = Object.assign(new Error('duplicate unique properties'), { code: 40105 })
    m.postService.createPost.mockRejectedValue(duplicate)
    m.postService.getOwnQuotes.mockResolvedValue(new Map([[TARGET.id, { id: id('Bare'), bare: true }]]))
    expect(await outcome(engage.repost(TARGET))).toMatchObject({ state: 'confirmed', documents: [{ id: id('Bare') }] })

    m.postService.getOwnQuotes.mockResolvedValue(new Map([[TARGET.id, { id: id('Quote'), bare: false }]]))
    expect(await outcome(engage.repost(TARGET))).toMatchObject({ state: 'failed', error: { code: 'DUPLICATE' } })
  })

  it('v10: undoing a repost deletes the bare quote, and refuses a quote with text (QUOTE_HAS_TEXT)', async () => {
    const { tickets, outcome, engage } = engine()
    m.topology.repostsAreQuotes = true
    m.strict.ownQuoteStrict.mockResolvedValue({ id: id('Quote'), bare: false })
    await expect(engage.unrepost(TARGET)).rejects.toMatchObject({ code: 'QUOTE_HAS_TEXT' })
    // An unreadable slot rejects the call: never a no-op ticket that reads as "undone".
    m.strict.ownQuoteStrict.mockRejectedValueOnce(new Error('read failed'))
    await expect(engage.unrepost(TARGET)).rejects.toThrow('read failed')

    m.strict.ownQuoteStrict.mockResolvedValue({ id: id('Bare'), bare: true })
    m.postService.deleteOwnPost.mockRejectedValue(new Error('Request timeout'))
    const ticket = await outcome(engage.unrepost(TARGET))
    expect(m.postService.deleteOwnPost).toHaveBeenCalledWith(id('Bare'), VIEWER)
    expect(ticket).toMatchObject({ state: 'unconfirmed', documents: [{ type: 'post', id: id('Bare'), action: 'delete' }] })
    // The slot read back (on v11 the tombstoned quote post stays, so its id proves nothing).
    m.strict.repostExists.mockResolvedValue(false)
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
    expect(m.strict.repostExists).toHaveBeenCalledWith(VIEWER, TARGET.id, 'post')

    m.topology.deletesAreTombstones = true
    expect((await engage.unrepost(TARGET)).documents).toEqual([])

    m.strict.ownQuoteStrict.mockResolvedValue(null)
    expect(await outcome(engage.unrepost(TARGET))).toMatchObject({ state: 'confirmed', documents: [] })
  })

  it('off v10: repost documents, gated per kind', async () => {
    const { outcome, engage } = engine()
    m.repostService.removeRepost.mockResolvedValue(true)
    expect(await outcome(engage.unrepost(TARGET))).toMatchObject({ state: 'confirmed' })
    expect(m.repostService.removeRepost).toHaveBeenCalledWith(TARGET.id, VIEWER)
    m.topology['repost:reply'] = false
    m.topology['bookmark:reply'] = false
    const reply = { ...TARGET, kind: 'reply' as const }
    await expect(engage.repost(reply)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(engage.bookmark(reply)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(engage.like({ ...TARGET, id: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    m.viewer = null
    await expect(engage.like(TARGET)).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
  })

  it('checks a bookmark with a strict read, and pages the bookmarks list', async () => {
    const { tickets, outcome, engage } = engine()
    m.bookmarkService.removeBookmark.mockRejectedValue(new Error('Request timeout'))
    const ticket = await outcome(engage.unbookmark(TARGET))
    m.bookmarkService.getBookmark.mockRejectedValue(new Error('read failed'))
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'unconfirmed', error: { userMessage: expect.any(String) } })
    expect(m.bookmarkService.getBookmark).toHaveBeenCalledWith(TARGET.id, VIEWER, { throwOnError: true })

    const ids = Array.from({ length: 25 }, (_, index) => id(`Bk${index}`))
    m.bookmarkService.getUserBookmarks.mockResolvedValue(ids.map(postId => ({ postId })))
    m.postService.getPostsByIdsForDisplay.mockImplementation(async (batch: string[]) => ({ posts: batch.slice(1).map(postId => post(postId)), preloaded: undefined }))
    const first = await engage.bookmarks()
    expect(validate(page(postDTO), first)).toEqual([])
    expect(first.items.map(item => item.id)).toEqual(ids.slice(1, 20))
    const second = await engage.bookmarks(first.cursor)
    expect(second).toMatchObject({ hasMore: false, cursor: null })
    expect(second.items.map(item => item.id)).toEqual(ids.slice(21))
  })
})

describe('graph and safety writes', () => {
  it('follows, naming the created document, and checks with a strict following read', async () => {
    const { tickets, outcome, graph } = engine()
    m.followService.followUser.mockResolvedValue({ success: true, transactionHash: id('Follow'), confirmed: false })
    const ticket = await outcome(graph.follow(AUTHOR))
    expect(ticket).toMatchObject({ state: 'unconfirmed', target: { identityId: AUTHOR }, documents: [{ type: 'follow', id: id('Follow'), action: 'create' }] })
    m.followService.getFollowing.mockResolvedValue([{ followingId: AUTHOR }])
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
    expect(m.followService.getFollowing).toHaveBeenCalledWith(VIEWER, { throwOnError: true })

    m.followService.unfollowUser.mockResolvedValue({ success: false, error: 'Insufficient balance (code=30000)' })
    expect(await outcome(graph.unfollow(AUTHOR))).toMatchObject({ state: 'failed', error: { outcome: 'refused' } })
    await expect(graph.follow(VIEWER)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('blocks with a message of at most 280 characters, and reports an unblock a followed list overrides', async () => {
    const { tickets, outcome, safety } = engine()
    await expect(safety.block(AUTHOR, { message: 'x'.repeat(281) })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(safety.block(AUTHOR, { message: 42 as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    m.blockService.blockUser.mockResolvedValue({ success: true, transactionHash: id('Block') })
    expect(await outcome(safety.block(AUTHOR, { message: '  spam  ' }))).toMatchObject({ state: 'confirmed' })
    expect(m.blockService.blockUser).toHaveBeenCalledWith(VIEWER, AUTHOR, 'spam')

    m.blockService.query.mockResolvedValue({ documents: [{ blockedId: AUTHOR, message: 'spam' }, { blockedId: id('Other') }] })
    const blocked = await safety.blocked()
    expect(validate(page(blockedUserDTO), blocked)).toEqual([])
    expect(blocked.items.map(item => [item.id, item.message])).toEqual([[AUTHOR, 'spam'], [id('Other'), null]])
    expect(m.blockService.query).toHaveBeenCalledWith({ where: [['$ownerId', '==', VIEWER]], limit: 100 })

    // check reads the block document itself, never lib's optimistic block cache.
    m.blockService.blockUser.mockResolvedValue({ success: true, transactionHash: id('Block'), confirmed: false })
    const unconfirmed = await outcome(safety.block(AUTHOR))
    m.strict.ownBlockExists.mockResolvedValue(false)
    expect(await tickets.check(unconfirmed.id)).toMatchObject({ state: 'unconfirmed', retryable: true })
    expect(m.strict.ownBlockExists).toHaveBeenCalledWith(VIEWER, AUTHOR)
    expect(m.blockService.getBlockProvenance).not.toHaveBeenCalled()

    m.blockService.unblockUser.mockResolvedValue({ success: true })
    m.blockService.getBlockProvenance.mockResolvedValue({ isBlocked: true, isOwnBlock: false, inheritedFrom: id('Lister') })
    expect(await outcome(safety.unblock(AUTHOR))).toMatchObject({ state: 'failed', error: { code: 'STILL_BLOCKED', outcome: 'local' } })
  })

  it('re-reads the blocked list after a block or unblock lands, on every page, and rejects an unreadable list', async () => {
    const { outcome, safety } = engine()
    const many = (count: number) => Array.from({ length: count }, (_, n) => ({ blockedId: id(`B${n + 1}`) }))
    m.blockService.query.mockResolvedValue({ documents: many(40) })
    const first = await safety.blocked()
    // A continuation reads from the list held for paging...
    m.blockService.query.mockResolvedValue({ documents: many(31) })
    expect((await safety.blocked(first.cursor)).items).toHaveLength(10)
    // ...until a block lands: then even a continuation re-reads.
    m.blockService.blockUser.mockResolvedValue({ success: true, transactionHash: id('Block') })
    expect(await outcome(safety.block(AUTHOR))).toMatchObject({ state: 'confirmed' })
    expect((await safety.blocked(first.cursor)).items).toHaveLength(1)

    m.blockService.query.mockResolvedValue({ documents: many(40) })
    const again = await safety.blocked()
    m.blockService.unblockUser.mockResolvedValue({ success: true, confirmed: false })
    m.blockService.getBlockProvenance.mockResolvedValue({ isBlocked: false, isOwnBlock: false, inheritedFrom: null })
    expect(await outcome(safety.unblock(id('B1')))).toMatchObject({ state: 'unconfirmed' })
    m.blockService.query.mockResolvedValue({ documents: many(30) })
    expect((await safety.blocked(again.cursor)).items).toEqual([])

    m.blockService.query.mockRejectedValue(new Error('no available addresses to retry'))
    await expect(safety.blocked()).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('tells an own block from one only a followed block list makes', async () => {
    const { safety } = engine()
    m.blockService.checkBlockedBatch.mockResolvedValue(new Map([[AUTHOR, true], [id('Listed'), true]]))
    m.blockService.getBlockSourcesBatch.mockResolvedValue(new Map([[AUTHOR, 'own'], [id('Listed'), 'inherited']]))
    const ids = [AUTHOR, id('Listed'), id('Free')]
    expect(await safety.isBlocked(ids)).toEqual({ [AUTHOR]: true, [id('Listed')]: true, [id('Free')]: false })
    expect(await safety.blockedBy(ids)).toEqual({ [AUTHOR]: 'self', [id('Listed')]: 'list', [id('Free')]: null })
    expect(m.blockService.getBlockSourcesBatch).toHaveBeenCalledWith(VIEWER, ids)
  })

  it('reports with lib\'s reason rules, gated by the topology', async () => {
    const { tickets, outcome, safety } = engine()
    await expect(safety.report(TARGET, 8)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(safety.report(TARGET, 9)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(safety.report(TARGET, 0, 'x'.repeat(501))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(safety.report({ ...TARGET, ownerId: VIEWER }, 0)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    m.reportService.fileReport.mockResolvedValue({ success: true, transactionHash: id('Report'), confirmed: false })
    const ticket = await outcome(safety.report(TARGET, 8, ' a scam '))
    expect(m.reportService.fileReport).toHaveBeenCalledWith(VIEWER, { kind: 'post', targetId: TARGET.id, targetOwnerId: AUTHOR, reason: 8, note: 'a scam' })
    expect(ticket).toMatchObject({ state: 'unconfirmed', documents: [{ type: 'report', id: id('Report'), contractId: YAPPR_CONTRACT_ID }] })
    m.reportService.getOwnReport.mockResolvedValue({ id: id('Report') })
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })

    m.topology.contractTakesReports = false
    await expect(safety.report(TARGET, 0)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})

describe('profiles.update', () => {
  it('maps the patch as web\'s editor and avatar picker write it', async () => {
    const { tickets, profiles } = engine()
    m.profileService.updateProfile.mockResolvedValue({})
    const ticket = await profiles.update({ displayName: 'Ann', avatar: { dicebear: { style: 'bottts', seed: 'abc' } }, bannerUri: null, nsfw: true })
    expect(await settled(tickets, ticket.id)).toMatchObject({ state: 'confirmed', target: { identityId: VIEWER } })
    expect(m.profileService.updateProfile).toHaveBeenCalledWith(VIEWER, {
      displayName: 'Ann', avatar: JSON.stringify({ seed: 'abc', style: 'bottts' }), bannerUri: '', nsfw: true,
    })
    await expect(profiles.update({ avatar: { dicebear: { style: 'nope', seed: 'a' } } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(profiles.update({ displayName: 'x'.repeat(51) })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(profiles.update({ handle: 'x' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('reports lib\'s own plan refusals as not sent, and checks an edit by reading the profile back', async () => {
    const { tickets, outcome, profiles } = engine()
    m.profileService.updateProfile.mockRejectedValue(new ListLimitError('Too many links'))
    expect(await outcome(profiles.update({ bio: 'b' })))
      .toMatchObject({ state: 'failed', error: { code: 'BAD_REQUEST', userMessage: 'Too many links' } })

    m.profileService.updateProfile.mockRejectedValue(new Error('Request timeout'))
    const ticket = await outcome(profiles.update({ bio: 'new bio' }))
    expect(ticket.state).toBe('unconfirmed')
    m.profileService.getProfile.mockResolvedValue({ bio: 'new bio', displayName: 'Ann' })
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
  })
})

describe('posts.publish and posts.delete', () => {
  /** createPost/createReply stubs that number what they create. */
  const OUT_OF_YAPP = 'Identity 9t2e does not have enough token balance, code=40700'
  const FEE_CHANGED = 'Document create of type post agreed to an action fee priced with a fee multiplier of 1000 permille and at most 10% more, but the fee multiplier is 1500 permille'

  function creating(failAt?: number, message = OUT_OF_YAPP) {
    let n = 0
    const next = (kind: 'post' | 'reply') => {
      if (n === failAt) {
        n++
        throw new Error(message)
      }
      const postId = id(`${kind}${n++}`)
      return kind === 'reply' ? { ...post(postId), parentId: TARGET.id } : post(postId)
    }
    m.postService.createPost.mockImplementation(async () => next('post'))
    m.replyService.createReply.mockImplementation(async () => next('reply'))
  }

  it('checks a draft before it is a ticket', async () => {
    const { posts } = engine()
    const parts = (n: number) => Array.from({ length: n }, () => ({ text: 'x' }))
    await expect(posts.publish({ parts: parts(11) })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(posts.publish({ parts: parts(2), replyTo: TARGET })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(posts.publish({ parts: [{ text: ' ​ ' }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(posts.publish({ parts: [{ text: 'x'.repeat(501) }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(posts.publish({ parts: [{ text: 'x' }], mediaUrl: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(posts.publish({ parts: [{ text: 'x' }], replyTo: TARGET, quote: TARGET })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('publishes a thread, naming each part, and resumes it with the posted ids after a failure', async () => {
    const { tickets, outcome, posts } = engine()
    creating(2)
    const draft = { parts: [{ text: 'one' }, { text: 'two' }, { text: 'three' }], sensitive: true }
    const ticket = await outcome(posts.publish(draft))
    expect(ticket).toMatchObject({
      state: 'failed',
      error: { code: 'INSUFFICIENT_YAPP' },
      progress: { done: 2, total: 3 },
      documents: [
        { type: 'post', id: id('post0'), part: 0, confirmed: true },
        { type: 'reply', id: id('reply1'), part: 1, confirmed: true },
      ],
    })
    expect(m.postService.createPost).toHaveBeenCalledWith(VIEWER, 'one', expect.objectContaining({ sensitive: true }))
    expect(m.replyService.createReply).toHaveBeenCalledWith(VIEWER, 'two', { rootPostId: id('post0'), replyToReplyId: undefined, parentOwnerId: VIEWER }, expect.anything())
    expect(emitted.some(e => e.event === 'content.created')).toBe(true)
    // Not retryable (out of YAPP): the host resumes by publishing again with the posted ids.
    await expect(tickets.retry(ticket.id)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
    creating()
    m.replyService.createReply.mockClear()
    const resumed = await outcome(posts.publish({ ...draft, resume: { postedIds: [id('post0'), id('reply1'), null] } }))
    expect(resumed).toMatchObject({ state: 'confirmed', documents: [{ part: 2, type: 'reply' }] })
    expect(m.replyService.createReply).toHaveBeenCalledTimes(1)
    expect(m.replyService.createReply).toHaveBeenCalledWith(VIEWER, 'three', { rootPostId: id('post0'), replyToReplyId: id('reply1'), parentOwnerId: VIEWER }, expect.anything())
  })

  it('resumes a thread with writes.retry after a retryable refusal, skipping the parts that landed', async () => {
    const { tickets, outcome, posts } = engine()
    creating(1, FEE_CHANGED)
    const ticket = await outcome(posts.publish({ parts: [{ text: 'one' }, { text: 'two' }] }))
    expect(ticket).toMatchObject({ state: 'failed', retryable: true, error: { code: 'FEE_CHANGED' }, documents: [{ part: 0 }] })
    m.postService.createPost.mockClear()
    m.replyService.createReply.mockClear()
    await tickets.retry(ticket.id)
    expect(await settled(tickets, ticket.id)).toMatchObject({ state: 'confirmed', documents: [{ part: 0 }, { part: 1, type: 'reply' }] })
    expect(m.postService.createPost).not.toHaveBeenCalled()
    expect(m.replyService.createReply).toHaveBeenCalledWith(VIEWER, 'two', expect.objectContaining({ rootPostId: id('post0') }), expect.anything())
  })

  it('never fails a thread with a timed-out part: unconfirmed, unprovable, not retryable', async () => {
    const { tickets, outcome, posts } = engine()
    m.postService.createPost.mockImplementation(async () => post(id('post0')))
    m.replyService.createReply
      .mockRejectedValueOnce(new Error('Request timeout'))
      .mockRejectedValueOnce(new Error(FEE_CHANGED))
    const ticket = await outcome(posts.publish({ parts: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }))
    expect(ticket).toMatchObject({ state: 'unconfirmed', retryable: false, documents: [{ part: 0 }] })
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'unconfirmed', retryable: false, error: { userMessage: expect.any(String) } })
    await expect(tickets.retry(ticket.id)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
  })

  it('marks a part the network did not confirm, and proves it with check', async () => {
    const { tickets, outcome, posts } = engine()
    m.topology.repostsAreQuotes = true
    creating()
    // references enforced: lib records the part as unconfirmed.
    m.postService.createPost.mockImplementation(async () => {
      m.unconfirmed.add(id('Late'))
      return { ...post(id('Late')), __createConfirmed: false }
    })
    m.postService.getPostById.mockResolvedValue(post(TARGET.id))
    const ticket = await outcome(posts.publish({ parts: [{ text: 'quote' }], quote: TARGET }))
    expect(m.postService.createPost).toHaveBeenCalledWith(VIEWER, 'quote', expect.objectContaining({ quotedPostId: TARGET.id }))
    expect(ticket).toMatchObject({ state: 'unconfirmed', target: TARGET, documents: [{ type: 'post', id: id('Late'), confirmed: false, part: 0 }] })
    m.documentExists.mockResolvedValue(false)
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'unconfirmed', retryable: true, error: { code: 'NOT_RECORDED' } })
    expect(m.documentExists).toHaveBeenCalledTimes(2)
  })

  it('replies to a loaded target, refuses a private one, and carries v10 media hashes', async () => {
    const { outcome, posts } = engine()
    creating()
    m.postService.getPostById.mockResolvedValue(null)
    m.replyService.getReplyById.mockResolvedValue(null)
    const gone = await outcome(posts.publish({ parts: [{ text: 'hi' }], replyTo: TARGET }))
    expect(gone).toMatchObject({ state: 'failed', error: { outcome: 'not-sent' } })

    m.postService.getPostById.mockResolvedValue(post(TARGET.id, { encryptedContent: 'x' as never }))
    expect(await outcome(posts.publish({ parts: [{ text: 'hi' }], replyTo: TARGET })))
      .toMatchObject({ state: 'failed', error: { code: 'NOT_SUPPORTED' } })

    m.topology.mediaCarriesHashes = true
    m.imageDigest.mockResolvedValue({ hash: new Uint8Array(32), fingerprint: new Uint8Array(8) })
    const withMedia = await outcome(posts.publish({ parts: [{ text: 'pic' }], mediaUrl: 'https://img.example/a.png' }))
    expect(withMedia.state).toBe('confirmed')
    expect(m.postService.createPost).toHaveBeenCalledWith(VIEWER, 'pic', expect.objectContaining({
      mediaUrl: 'https://img.example/a.png', mediaHashes: { mediaHash: new Uint8Array(32), mediaFingerprint: new Uint8Array(8) },
    }))
  })

  it('emits content.created with the created post as a DTO', async () => {
    const { outcome, posts } = engine()
    creating()
    await outcome(posts.publish({ parts: [{ text: 'hello' }] }))
    await vi.waitFor(() => expect(emitted.find(e => e.event === 'content.created')).toBeTruthy())
    const created = emitted.find(e => e.event === 'content.created')?.payload as { kind: string; id: string; post: unknown }
    expect(created).toMatchObject({ kind: 'post', id: id('post0'), confirmed: true })
    expect(validate(postDTO, created.post)).toEqual([])
  })

  it('deletes only the viewer\'s own posts: a real delete, or a tombstone', async () => {
    const { tickets, outcome, posts } = engine()
    const own = { ...TARGET, ownerId: VIEWER }
    await expect(posts.delete(TARGET)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    m.postService.deleteOwnPost.mockResolvedValue(true)
    expect(await outcome(posts.delete(own)))
      .toMatchObject({ state: 'confirmed', documents: [{ type: 'post', id: TARGET.id, action: 'delete', confirmed: true }] })

    m.topology.deletesAreTombstones = true
    m.replyService.deleteOwnReply.mockRejectedValue(new Error('Request timeout'))
    const reply = { ...own, kind: 'reply' as const }
    const ticket = await outcome(posts.delete(reply))
    expect(ticket).toMatchObject({ state: 'unconfirmed', documents: [] })
    m.postService.getPostById.mockResolvedValue(null)
    m.replyService.getReplyById.mockResolvedValue({ ...post(TARGET.id), parentId: id('P'), deleted: true })
    expect(await tickets.check(ticket.id)).toMatchObject({ state: 'confirmed' })
  })
})

describe('notifications', () => {
  const notification = (key: string, type: string, at: number) => ({
    id: key, type, from: { ...user(AUTHOR), displayName: 'Ann' }, createdAt: new Date(at), read: false,
    ...(type === 'follow' ? {} : { post: post(id(`N${key}`)) }),
  })

  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], readIds: [], lastFetchTimestamp: 0 })
    useSettingsStore.getState().setNotificationSettings({ likes: true, follows: true })
  })

  it('loads once per account, filters by tab, pages by keyset and marks the visible ones read', async () => {
    const notifications = createNotificationsModule(emit).api
    const items = [
      ...Array.from({ length: 35 }, (_, index) => notification(`like${index}`, 'like', 10_000 - index)),
      notification('follow', 'follow', 20_000),
    ]
    m.notificationService.getInitialNotifications.mockResolvedValue({ notifications: items, latestTimestamp: 20_000 })
    const first = await notifications.list({ filter: 'like' })
    expect(validate(page(notificationDTO), first)).toEqual([])
    expect(first.items).toHaveLength(30)
    expect(first.items[0]).toMatchObject({ type: 'like', actor: { id: AUTHOR, displayName: 'Ann' }, target: { kind: 'post' }, read: false })
    const second = await notifications.list({ filter: 'like', cursor: first.cursor })
    expect(second).toMatchObject({ hasMore: false })
    expect(second.items).toHaveLength(5)
    await expect(notifications.list({ filter: 'like', cursor: first.cursor?.replace(/.$/, '!') })).rejects.toMatchObject({ code: 'BAD_CURSOR' })
    expect(m.notificationService.getInitialNotifications).toHaveBeenCalledTimes(1)
    expect(await notifications.unreadCount()).toBe(36)

    // Turning likes off hides them: the badge drops, and mark-all-read leaves them unread.
    emitted = []
    useSettingsStore.getState().setNotificationSettings({ likes: false })
    expect(emitted).toEqual([{ event: 'notifications.count', payload: { unread: 1 } }])
    await notifications.markVisibleRead()
    expect(await notifications.unreadCount()).toBe(0)
    useSettingsStore.getState().setNotificationSettings({ likes: true })
    expect(await notifications.unreadCount()).toBe(35)
    await notifications.markRead(['like0'])
    expect(emitted.at(-1)).toEqual({ event: 'notifications.count', payload: { unread: 34 } })
  })

  it('starts each account from its own read state, even after a sign-out on the same engine', async () => {
    const module_ = createNotificationsModule(emit)
    const notifications = module_.api
    m.notificationService.getInitialNotifications.mockResolvedValue({ notifications: [notification('a', 'like', 100)], latestTimestamp: 100 })
    await notifications.list()
    await notifications.markVisibleRead()
    expect(await notifications.unreadCount()).toBe(0)
    // Sign-out removes the stored copy (session.signOut); another account signs in.
    kv.delete(useNotificationStore.persist.getOptions().name ?? '')
    m.viewer = id('Other')
    expect(await notifications.unreadCount()).toBe(1)
    await notifications.markVisibleRead()

    // The same account signing out and back in on this engine reloads too (session.changed).
    kv.delete(useNotificationStore.persist.getOptions().name ?? '')
    module_.sessionChanged({ reason: 'signed-out' })
    expect(await notifications.unreadCount()).toBe(1)
    expect(m.notificationService.getInitialNotifications).toHaveBeenLastCalledWith(id('Other'), new Set())
  })

  it('polls from the watermark and merges what arrived', async () => {
    const notifications = createNotificationsModule(emit).api
    m.notificationService.getInitialNotifications.mockResolvedValue({ notifications: [notification('a', 'like', 100)], latestTimestamp: 100 })
    expect(await notifications.poll()).toEqual({ added: 1, unread: 1 })
    m.notificationService.pollNewNotifications.mockResolvedValue({ notifications: [notification('b', 'follow', 200)], latestTimestamp: 200 })
    expect(await notifications.poll()).toEqual({ added: 1, unread: 2 })
    expect(m.notificationService.pollNewNotifications).toHaveBeenCalledWith(VIEWER, 100, expect.any(Set))
    expect(emitted.at(-1)).toEqual({ event: 'notifications.count', payload: { unread: 2 } })
    m.viewer = null
    await expect(notifications.list()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
  })
})
