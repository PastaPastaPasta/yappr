import { describe, expect, it } from 'vitest'
import type { Post, User } from '@/lib/types'
import { toPostDTO, toProfileDTO, type PostMappingOptions } from '../../src/api/dto'

const author: User = {
  id: 'A'.repeat(44), username: 'alice.dash', displayName: 'Alice', avatar: 'https://img/a.png',
  followers: 0, following: 0, joinedAt: new Date(0), hasDpns: true,
}

const post = (overrides: Partial<Post> = {}): Post => ({
  id: 'P'.repeat(44), author, content: 'hello', createdAt: new Date(1000),
  likes: 3, reposts: 1, replies: 2, quotes: 0, views: 9,
  ...overrides,
})

const signedOut: PostMappingOptions = { signedIn: false, defaultAvatarUrl: id => `dicebear:${id.slice(0, 2)}` }
const signedIn: PostMappingOptions = { ...signedOut, signedIn: true }

describe('toPostDTO', () => {
  it('maps the fields screens render and nothing internal', () => {
    const dto = toPostDTO(post({
      _enrichment: { authorIsBlocked: false, authorIsFollowing: true, authorAvatarUrl: 'x' },
      media: [{ id: 'm', type: 'image', url: 'ipfs://x', hashes: { mediaHash: new Uint8Array(32), mediaFingerprint: new Uint8Array(8) } }],
    }), signedOut)
    expect(dto).toEqual({
      id: 'P'.repeat(44), kind: 'post',
      author: { id: 'A'.repeat(44), username: 'alice', displayName: 'Alice', avatarUrl: 'https://img/a.png', resolved: true },
      content: 'hello', createdAt: new Date(1000),
      stats: { likes: 3, reposts: 1, replies: 2, quotes: 0 },
      media: [{ type: 'image', url: 'ipfs://x' }],
      sensitive: false, deleted: false, encrypted: false, quotedRemoved: false,
    })
  })

  it('adds viewer marks and author relations only when signed in', () => {
    const marked = post({ liked: true, _enrichment: { authorIsBlocked: true, authorIsFollowing: false, authorAvatarUrl: '' } })
    expect(toPostDTO(marked, signedIn).viewer).toEqual({
      liked: true, reposted: false, bookmarked: false, authorBlocked: true, followsAuthor: false,
    })
    expect(toPostDTO(marked, signedOut).viewer).toBeUndefined()
  })

  it('falls back to a name and the default avatar, and flags an unresolved author', () => {
    const blank = { ...author, username: '', displayName: '', avatar: '', hasDpns: undefined }
    expect(toPostDTO(post({ author: blank }), signedOut).author).toEqual({
      id: author.id, username: null, displayName: `User ${author.id.slice(-6)}`, avatarUrl: 'dicebear:AA', resolved: false,
    })
    expect(toPostDTO(post({ author: { ...blank, username: 'bob.dash', hasDpns: true } }), signedOut).author)
      .toMatchObject({ username: 'bob', displayName: 'bob', resolved: true })
  })

  it('treats lib\'s "Unknown User" placeholder (a failed batch author lookup) as unresolved', () => {
    const placeholder = { ...author, username: '', displayName: 'Unknown User', avatar: '', hasDpns: false }
    expect(toPostDTO(post({ author: placeholder }), signedOut).author).toEqual({
      id: author.id, username: null, displayName: `User ${author.id.slice(-6)}`, avatarUrl: 'dicebear:AA', resolved: false,
    })
  })

  it('flags private posts and maps quotes, replies, reposts and embeds', () => {
    const dto = toPostDTO(post({
      targetKind: 'reply', parentId: 'parent', rootPostId: 'root',
      encryptedContent: new Uint8Array([1]),
      quotedReplyId: 'q', quotedPost: post({ id: 'Q'.repeat(44), content: 'quoted' }),
      repostedBy: { id: 'R', displayName: 'Rita', username: undefined }, repostTimestamp: new Date(5),
      embedContractId: 'c', embedDocType: 'poll', embedId: 'e',
    }), signedOut)
    expect(dto).toMatchObject({
      kind: 'reply', parentId: 'parent', rootPostId: 'root', encrypted: true, quotedPostId: 'q',
      quoted: { id: 'Q'.repeat(44), content: 'quoted' },
      repostedBy: { id: 'R', displayName: 'Rita' }, repostTimestamp: new Date(5),
      embed: { contractId: 'c', documentType: 'poll', id: 'e' },
    })
    expect('username' in (dto.repostedBy ?? {})).toBe(false)
  })
})

describe('toProfileDTO', () => {
  const stats = { posts: 4, followers: 5, following: 6 }

  it('names a profile-less identity by its DPNS label', () => {
    expect(toProfileDTO({ id: 'X'.repeat(44), profile: null, usernames: ['bob.dash', 'bobby.dash'], stats, defaultAvatarUrl: 'dicebear' }))
      .toEqual({
        id: 'X'.repeat(44), username: 'bob', usernames: ['bob', 'bobby'], displayName: 'bob',
        avatarUrl: 'dicebear', hasProfile: false, stats,
      })
  })

  it('falls back to a short id without a name or profile', () => {
    expect(toProfileDTO({ id: 'X'.repeat(38) + 'abcdef', profile: null, usernames: [], stats, defaultAvatarUrl: 'd' }).displayName)
      .toBe('User abcdef')
  })

  it('carries the profile document fields, omitting empty ones', () => {
    const dto = toProfileDTO({
      id: author.id, profile: { ...author, bio: 'hi', website: '', socialLinks: [{ platform: 'github', handle: 'a' }] },
      usernames: ['alice.dash'], stats, defaultAvatarUrl: 'd',
    })
    expect(dto).toMatchObject({ displayName: 'Alice', avatarUrl: 'https://img/a.png', hasProfile: true, bio: 'hi', socialLinks: [{ platform: 'github', handle: 'a' }] })
    expect('website' in dto).toBe(false)
  })
})
