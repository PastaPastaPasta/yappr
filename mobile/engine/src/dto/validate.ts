/**
 * Runtime shape checks for every DTO the read API returns. The contract tests
 * run each result through these, so a lib change that leaks a field (an
 * `_enrichment`, a wasm object) or drops one fails there. Objects are strict:
 * unknown keys fail, and optional keys must be absent rather than undefined.
 * Dependency-free, so the host's tests may reuse them.
 */

export type Check = (value: unknown, path: string, errors: string[]) => void

const fail = (errors: string[], path: string, expected: string, value: unknown) =>
  errors.push(`${path}: expected ${expected}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`)

const primitive = (expected: string, test: (value: unknown) => boolean): Check =>
  (value, path, errors) => { if (!test(value)) fail(errors, path, expected, value) }

export const str = primitive('string', value => typeof value === 'string')
export const nonEmpty = primitive('non-empty string', value => typeof value === 'string' && value.length > 0)
export const id = primitive('base58 id', value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value))
export const count = primitive('count', value => typeof value === 'number' && Number.isInteger(value) && value >= 0)
export const bool = primitive('boolean', value => typeof value === 'boolean')
export const date = primitive('valid Date', value => value instanceof Date && !Number.isNaN(value.getTime()))

export const literal = (...options: readonly string[]): Check =>
  primitive(options.map(option => JSON.stringify(option)).join(' | '), value => options.includes(value as string))
const isNull = primitive('null', value => value === null)
const isTrue = primitive('true', value => value === true)

export const nullable = (check: Check): Check => (value, path, errors) => { if (value !== null) check(value, path, errors) }

export const array = (check: Check): Check => (value, path, errors) => {
  if (!Array.isArray(value)) return fail(errors, path, 'array', value)
  value.forEach((item, index) => check(item, `${path}[${index}]`, errors))
}

export const record = (check: Check): Check => (value, path, errors) => {
  if (!isPlainObject(value)) return fail(errors, path, 'object', value)
  for (const [key, item] of Object.entries(value)) check(item, `${path}.${key}`, errors)
}

/** Strict object: `required` keys must be present, `optional` ones absent or valid, nothing else. */
export const object = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (value, path, errors) => {
  if (!isPlainObject(value)) return fail(errors, path, 'object', value)
  for (const [key, check] of Object.entries(required)) {
    if (!(key in value)) errors.push(`${path}.${key}: missing`)
    else check(value[key], `${path}.${key}`, errors)
  }
  for (const [key, item] of Object.entries(value)) {
    if (key in required) continue
    const check = optional[key]
    if (!check) errors.push(`${path}.${key}: unexpected key`)
    else if (item === undefined) errors.push(`${path}.${key}: present but undefined`)
    else check(item, `${path}.${key}`, errors)
  }
}

const lazy = (get: () => Check): Check => (value, path, errors) => get()(value, path, errors)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

// ---- DTOs (mirror src/api/dto.ts) ----

const avatar: Check = (value, path, errors) => {
  object({ uri: nullable(nonEmpty), dicebear: nullable(object({ style: nonEmpty, seed: nonEmpty })) })(value, path, errors)
  const { uri, dicebear } = (value ?? {}) as { uri?: unknown; dicebear?: unknown }
  if ((uri === null) === (dicebear === null)) errors.push(`${path}: exactly one of uri and dicebear`)
}

const authorKeys = { id, username: nullable(nonEmpty), displayName: nonEmpty, avatar, resolved: bool }
export const authorDTO = object(authorKeys)
export const userSummaryDTO = object(authorKeys, { bio: str, followers: count, following: count, viewerFollows: bool })

const stats = object({ likes: count, reposts: count, replies: count, quotes: count })
const viewerMarks = { liked: bool, reposted: bool, bookmarked: bool, ownQuoteId: nullable(id) }

const postRequired = {
  id,
  kind: literal('post', 'reply'),
  author: authorDTO,
  content: str,
  createdAt: date,
  stats,
  media: array(object({ type: literal('image', 'video', 'gif'), url: nonEmpty }, { thumbnail: str, alt: str, width: count, height: count })),
  sensitive: bool,
  deleted: bool,
  encrypted: bool,
  quotedRemoved: bool,
  bareRepost: bool,
}
const postOptional = {
  viewer: object({ ...viewerMarks, authorBlocked: bool, followsAuthor: bool }),
  parentId: id,
  rootPostId: id,
  quotedPostId: id,
  quoted: lazy(() => postDTO),
  repostedBy: object({ id }, { username: str, displayName: str, others: count }),
  repostTimestamp: date,
  embed: object({ contractId: id, documentType: nonEmpty, id }),
  poll: object({ id }, { linkUrl: nonEmpty }),
}
export const postDTO: Check = object(postRequired, postOptional)

const threadFields = { depth: primitive('0 | 1', value => value === 0 || value === 1), isAuthorThread: bool, hiddenReplyCount: count }
const liveReply = object({ ...postRequired, ...threadFields }, postOptional)
/** A deleted-reply stub stands in for a document that is gone: a blank author, no avatar. */
const stubReply = object({
  ...postRequired,
  ...threadFields,
  author: object({ id: literal(''), username: isNull, displayName: literal(''), avatar: object({ uri: isNull, dicebear: isNull }), resolved: bool }),
  deleted: isTrue,
  deletedStub: isTrue,
}, postOptional)
const isStub = (value: unknown) => isPlainObject(value) && 'deletedStub' in value
const threadReply: Check = (value, path, errors) => (isStub(value) ? stubReply : liveReply)(value, path, errors)

export const page = (item: Check): Check =>
  object({ items: array(item), cursor: nullable(nonEmpty), hasMore: bool })

export const threadDTO = object({
  focus: nullable(postDTO),
  ancestors: array(postDTO),
  removedAncestorIds: array(id),
  replies: page(threadReply),
})

export const profileReplyDTO = object({ ...postRequired, parentRemoved: bool }, { ...postOptional, parent: postDTO })

export const profileDTO = object(
  {
    id, username: nullable(nonEmpty), usernames: array(nonEmpty), displayName: nonEmpty, avatar, hasProfile: bool,
    stats: object({ posts: count, followers: count, following: count }),
  },
  {
    bio: str, location: str, website: str, pronouns: str, bannerUrl: str, nsfw: bool, joinedAt: date,
    socialLinks: array(object({ platform: str, handle: str })),
    paymentUris: array(object({ scheme: str, uri: str }, { label: str })),
    viewer: object({ follows: bool, blocks: nullable(bool), isSelf: bool }),
  },
)

export const engagementDTO = object({ user: userSummaryDTO }, { quote: object({ id, content: str }) })
export const engagementCountsDTO = object({ likes: count, reposts: count, quotes: count, truncated: bool })
export const engagementPage = object({ items: array(engagementDTO), cursor: nullable(nonEmpty), hasMore: bool, truncated: bool })
export const engageStatsDTO = object({ stats }, { viewer: object(viewerMarks) })

export const pollDTO = object(
  {
    id, ownerId: id, question: nonEmpty, options: array(object({ text: nonEmpty, votes: count })), multiChoice: bool,
    endsAt: nullable(date), createdAt: date, totalVotes: nullable(count), tallyIncludesLate: bool,
  },
  { myVotes: nullable(array(count)) },
)

export const tagDTO = object({
  tag: nonEmpty, kind: literal('hashtag', 'cashtag'), display: nonEmpty, count, countKind: literal('posts', 'likes'),
})
export const rankedUserDTO = object({ user: userSummaryDTO, count, by: literal('likes', 'followers') })

export const messageDTO = object({ id: nonEmpty, sender: id, text: str, at: date, own: bool, pending: bool })
export const conversationDTO = object({
  key: nonEmpty, backend: literal('v5', 'legacy'), kind: literal('direct', 'group'), peer: nullable(authorDTO),
  ownerId: nullable(id), name: nullable(str), members: array(id), isOwner: bool,
  lastMessage: nullable(object({ text: str, at: date, own: bool })), lastActivity: nullable(date), unread: count,
  flags: object({ hidden: bool, unreadable: bool, removed: bool, ended: bool, blocked: bool, unsaved: bool, draft: bool }),
  peerReadAt: nullable(date),
})
export const dmStatusDTO = object({
  backend: literal('v5', 'legacy'), locked: bool, ready: bool, unreadTotal: count, unreadConversations: count, capReached: bool,
  retention: nullable(literal('30d', '90d', '1y', 'never')), blocked: array(id),
  recovery: nullable(object({ phase: literal('invites', 'contacts-recent', 'groups', 'contacts-older'), done: count, total: count, found: count })),
  error: nullable(str),
})

export const blockedUserDTO = object({ ...authorKeys, message: nullable(nonEmpty) }, { bio: str, followers: count, following: count, viewerFollows: bool })

export const notificationDTO = object(
  {
    id: nonEmpty,
    type: literal('follow', 'mention', 'like', 'repost', 'quote', 'reply', 'privateFeedRequest', 'privateFeedApproved', 'privateFeedRevoked', 'blogPost', 'blogComment'),
    actor: authorDTO,
    at: date,
    read: bool,
    target: nullable(object({ id, kind: literal('post', 'reply') })),
    preview: nullable(postDTO),
  },
  { blog: object({ blogId: nonEmpty, slug: nonEmpty }), likers: count, noticed: bool },
)

/** Every problem with `value`, as `path: message` lines; empty when it is valid. */
export function validate(check: Check, value: unknown, path = '$'): string[] {
  const errors: string[] = []
  check(value, path, errors)
  return errors
}
