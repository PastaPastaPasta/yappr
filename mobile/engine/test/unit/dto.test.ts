import { describe, expect, it } from 'vitest'
import type { Post, User } from '@/lib/types'
import { avatarFromField, toPostDTO, toProfileDTO, toUserSummaryDTO, type AvatarDTO, type PostMappingOptions } from '../../src/api/dto'
import { authorDTO, postDTO, profileDTO, userSummaryDTO, validate } from '../../src/dto/validate'

const ID = (c: string) => c.repeat(44)

const author: User = {
  id: ID('A'), username: 'alice.dash', displayName: 'Alice', avatar: 'https://img/a.png',
  followers: 0, following: 0, joinedAt: new Date(0), hasDpns: true,
}

const post = (overrides: Partial<Post> = {}): Post => ({
  id: ID('P'), author, content: 'hello', createdAt: new Date(1000),
  likes: 3, reposts: 1, replies: 2, quotes: 0, views: 9,
  ...overrides,
})

const signedOut: PostMappingOptions = { signedIn: false, avatars: new Map() }
const signedIn: PostMappingOptions = { ...signedOut, signedIn: true }
const thumbs = (seed: string): AvatarDTO => ({ uri: null, dicebear: { style: 'thumbs', seed } })

describe('avatarFromField', () => {
  it('reads the stored field as lib parseAvatarField does', () => {
    expect(avatarFromField('ipfs://cid', ID('X'))).toEqual({ uri: 'ipfs://cid', dicebear: null })
    expect(avatarFromField(JSON.stringify({ style: 'bottts', seed: 's' }), ID('X'))).toEqual({ uri: null, dicebear: { style: 'bottts', seed: 's' } })
    expect(avatarFromField(JSON.stringify({ style: 'nope', seed: 's' }), ID('X'))).toEqual(thumbs('s'))
    expect(avatarFromField('plain-seed', ID('X'))).toEqual(thumbs('plain-seed'))
    expect(avatarFromField(undefined, ID('X'))).toEqual(thumbs(ID('X')))
  })
})

describe('toPostDTO', () => {
  it('maps the fields screens render and nothing internal', () => {
    const dto = toPostDTO(post({
      _enrichment: { authorIsBlocked: false, authorIsFollowing: true, authorAvatarUrl: 'x' },
      media: [{ id: 'm', type: 'image', url: 'ipfs://x', hashes: { mediaHash: new Uint8Array(32), mediaFingerprint: new Uint8Array(8) } }],
    }), signedOut)
    expect(dto).toEqual({
      id: ID('P'), kind: 'post',
      author: { id: ID('A'), username: 'alice', displayName: 'Alice', avatar: { uri: 'https://img/a.png', dicebear: null }, resolved: true },
      content: 'hello', createdAt: new Date(1000),
      stats: { likes: 3, reposts: 1, replies: 2, quotes: 0 },
      media: [{ type: 'image', url: 'ipfs://x' }],
      sensitive: false, deleted: false, encrypted: false, quotedRemoved: false, bareRepost: false,
    })
    expect(validate(postDTO, dto)).toEqual([])
  })

  it('adds viewer marks and author relations only when signed in', () => {
    const marked = post({ liked: true, ownQuote: { id: ID('Q'), bare: true }, _enrichment: { authorIsBlocked: true, authorIsFollowing: false, authorAvatarUrl: '' } })
    expect(toPostDTO(marked, signedIn).viewer).toEqual({
      liked: true, reposted: false, bookmarked: false, ownQuoteId: ID('Q'), ownQuoteBare: true, authorBlocked: true, followsAuthor: false,
    })
    expect(validate(postDTO, toPostDTO(marked, signedIn))).toEqual([])
    expect(toPostDTO(marked, signedOut).viewer).toBeUndefined()
  })

  it('tells a v10 quote with text in the viewer\'s slot from a bare repost (web ownQuote.bare)', () => {
    const quoted = post({ reposted: true, ownQuote: { id: ID('Q'), bare: false } })
    expect(toPostDTO(quoted, signedIn).viewer).toMatchObject({ reposted: true, ownQuoteId: ID('Q'), ownQuoteBare: false })
    expect(toPostDTO(post(), signedIn).viewer).toMatchObject({ reposted: false, ownQuoteId: null, ownQuoteBare: false })
  })

  it('never ships a generated avatar as a data URI: the stored recipe wins, else the default', () => {
    const generated = { ...author, avatar: 'data:image/svg+xml;base64,AAAA' }
    expect(toPostDTO(post({ author: generated }), signedOut).author.avatar).toEqual(thumbs(ID('A')))
    const avatars = new Map([[ID('A'), { uri: null, dicebear: { style: 'bottts', seed: 'x' } }]])
    expect(toPostDTO(post({ author: generated }), { signedIn: false, avatars }).author.avatar).toEqual(avatars.get(ID('A')))
  })

  it('falls back to a name, flags an unresolved author', () => {
    const blank = { ...author, username: '', displayName: '', avatar: '', hasDpns: undefined }
    const dto = toPostDTO(post({ author: blank }), signedOut).author
    expect(dto).toEqual({ id: author.id, username: null, displayName: `User ${author.id.slice(-6)}`, avatar: thumbs(ID('A')), resolved: false })
    expect(validate(authorDTO, dto)).toEqual([])
    expect(toPostDTO(post({ author: { ...blank, username: 'bob.dash', hasDpns: true } }), signedOut).author)
      .toMatchObject({ username: 'bob', displayName: 'bob', resolved: true })
  })

  it('treats lib\'s "Unknown User" placeholder (a failed batch author lookup) as unresolved', () => {
    const placeholder = { ...author, username: '', displayName: 'Unknown User', avatar: '', hasDpns: false }
    expect(toPostDTO(post({ author: placeholder }), signedOut).author).toEqual({
      id: author.id, username: null, displayName: `User ${author.id.slice(-6)}`, avatar: thumbs(ID('A')), resolved: false,
    })
  })

  it('shows the username, never "Unknown User", for an author with a DPNS name but no profile', () => {
    // resolvePostAuthorsBatch on a reposted post: the name is found, the placeholder display name stays.
    const nameOnly = { ...author, username: 'yappr-e2e-0', displayName: 'Unknown User', avatar: '', hasDpns: true }
    expect(toPostDTO(post({ author: nameOnly }), signedOut).author).toEqual({
      id: author.id, username: 'yappr-e2e-0', displayName: 'yappr-e2e-0', avatar: thumbs(ID('A')), resolved: true,
    })
    expect(toPostDTO(post({ quotedPost: post({ id: ID('Q'), author: nameOnly }) }), signedOut).quoted?.author.displayName).toBe('yappr-e2e-0')
  })

  it('flags private posts and maps quotes, replies, reposts and embeds', () => {
    const dto = toPostDTO(post({
      targetKind: 'reply', parentId: ID('B'), rootPostId: ID('C'),
      encryptedContent: new Uint8Array([1]),
      quotedReplyId: ID('Q'), quotedPost: post({ id: ID('Q'), content: 'quoted' }),
      repostedBy: { id: ID('R'), displayName: 'Rita', username: undefined }, repostedByOthers: 2, repostTimestamp: new Date(5),
      embedContractId: ID('E'), embedDocType: 'poll', embedId: ID('F'),
    }), signedOut)
    expect(dto).toMatchObject({
      kind: 'reply', parentId: ID('B'), rootPostId: ID('C'), encrypted: true, quotedPostId: ID('Q'),
      quoted: { id: ID('Q'), content: 'quoted' },
      repostedBy: { id: ID('R'), displayName: 'Rita', others: 2 }, repostTimestamp: new Date(5),
      embed: { contractId: ID('E'), documentType: 'poll', id: ID('F') },
    })
    expect('username' in (dto.repostedBy ?? {})).toBe(false)
    expect(toPostDTO(post({ repostedBy: { id: ID('R'), username: 'rita.dash', displayName: '' } }), signedOut).repostedBy)
      .toEqual({ id: ID('R'), username: 'rita' })
    expect(validate(postDTO, dto)).toEqual([])
  })
})

describe('toUserSummaryDTO', () => {
  it('names a user by profile, then DPNS label, then id, and reads the stored avatar', () => {
    const dto = toUserSummaryDTO({ id: ID('U'), username: 'carol.dash', profile: { displayName: '', avatar: 'https://a' }, followers: 2, following: 0, viewerFollows: false })
    expect(dto).toEqual({
      id: ID('U'), username: 'carol', displayName: 'carol', avatar: { uri: 'https://a', dicebear: null }, resolved: true,
      followers: 2, following: 0, viewerFollows: false,
    })
    expect(validate(userSummaryDTO, dto)).toEqual([])
    expect(toUserSummaryDTO({ id: ID('U'), username: null }).displayName).toBe(`User ${ID('U').slice(-6)}`)
  })
})

describe('toProfileDTO', () => {
  const stats = { posts: 4, followers: 5, following: 6 }

  it('names a profile-less identity by its DPNS label', () => {
    const dto = toProfileDTO({ id: ID('X'), profile: null, avatar: thumbs(ID('X')), usernames: ['bob.dash', 'bobby.dash'], stats })
    expect(dto).toEqual({
      id: ID('X'), username: 'bob', usernames: ['bob', 'bobby'], displayName: 'bob', avatar: thumbs(ID('X')), hasProfile: false, stats,
    })
    expect(validate(profileDTO, dto)).toEqual([])
  })

  it('falls back to a short id without a name or profile', () => {
    expect(toProfileDTO({ id: 'X'.repeat(38) + 'abcdef', profile: null, avatar: thumbs('x'), usernames: [], stats }).displayName)
      .toBe('User abcdef')
  })

  it('carries the profile document fields and the viewer relation, omitting empty ones', () => {
    const dto = toProfileDTO({
      id: author.id, avatar: { uri: 'https://img/a.png', dicebear: null },
      profile: { ...author, bio: 'hi', website: '', socialLinks: [{ platform: 'github', handle: 'a' }], paymentUris: [{ scheme: 'dash:', uri: 'dash:X' }] },
      usernames: ['alice.dash'], stats, viewer: { follows: true, blocks: false, blockedBy: null, isSelf: false },
    })
    expect(dto).toMatchObject({
      displayName: 'Alice', hasProfile: true, bio: 'hi', socialLinks: [{ platform: 'github', handle: 'a' }],
      paymentUris: [{ scheme: 'dash:', uri: 'dash:X' }], viewer: { follows: true, blocks: false, blockedBy: null, isSelf: false },
    })
    expect('website' in dto).toBe(false)
    expect(validate(profileDTO, dto)).toEqual([])
  })
})

describe('validators', () => {
  const valid = toPostDTO(post(), signedOut)

  it('reject leaked internals, undefined optionals, bad avatars and wrong types', () => {
    expect(validate(postDTO, { ...valid, _enrichment: {} })).toEqual(['$._enrichment: unexpected key'])
    expect(validate(postDTO, { ...valid, parentId: undefined })).toEqual(['$.parentId: present but undefined'])
    expect(validate(postDTO, { ...valid, author: { ...valid.author, avatar: { uri: 'https://a', dicebear: { style: 's', seed: 'x' } } } }))
      .toEqual(['$.author.avatar: exactly one of uri and dicebear'])
    expect(validate(postDTO, { ...valid, createdAt: 1000, stats: { ...valid.stats, likes: -1 } }))
      .toEqual(['$.createdAt: expected valid Date, got number', '$.stats.likes: expected count, got number'])
    const withoutContent: Record<string, unknown> = { ...valid }
    delete withoutContent.content
    expect(validate(postDTO, withoutContent)).toEqual(['$.content: missing'])
  })
})
