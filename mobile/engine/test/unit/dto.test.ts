import { describe, expect, it } from 'vitest'
import type { Post, User } from '@/lib/types'
import { toPostDTO, toProfileDTO } from '../../src/api/dto'

const author: User = {
  id: 'A'.repeat(44), username: 'alice.dash', displayName: 'Alice', avatar: 'https://img/a.png',
  followers: 0, following: 0, joinedAt: new Date(0),
}

const post = (overrides: Partial<Post> = {}): Post => ({
  id: 'P'.repeat(44), author, content: 'hello', createdAt: new Date(1000),
  likes: 3, reposts: 1, replies: 2, quotes: 0, views: 9,
  ...overrides,
})

describe('toPostDTO', () => {
  it('maps the fields screens render and nothing internal', () => {
    const dto = toPostDTO(post({
      _enrichment: { authorIsBlocked: false, authorIsFollowing: true, authorAvatarUrl: 'x' },
      media: [{ id: 'm', type: 'image', url: 'ipfs://x', hashes: { mediaHash: new Uint8Array(32), mediaFingerprint: new Uint8Array(8) } }],
    }), false)
    expect(dto).toEqual({
      id: 'P'.repeat(44), kind: 'post',
      author: { id: 'A'.repeat(44), username: 'alice', displayName: 'Alice', avatarUrl: 'https://img/a.png' },
      content: 'hello', createdAt: new Date(1000),
      stats: { likes: 3, reposts: 1, replies: 2, quotes: 0 },
      media: [{ type: 'image', url: 'ipfs://x' }],
      sensitive: false, deleted: false, encrypted: false, quotedRemoved: false,
    })
  })

  it('adds viewer marks only when signed in', () => {
    expect(toPostDTO(post({ liked: true }), true).viewer).toEqual({ liked: true, reposted: false, bookmarked: false })
    expect(toPostDTO(post({ liked: true }), false).viewer).toBeUndefined()
  })

  it('flags private posts and maps quotes, replies and embeds', () => {
    const dto = toPostDTO(post({
      targetKind: 'reply', parentId: 'parent', rootPostId: 'root',
      encryptedContent: new Uint8Array([1]),
      quotedReplyId: 'q', quotedPost: post({ id: 'Q'.repeat(44), content: 'quoted' }),
      embedContractId: 'c', embedDocType: 'poll', embedId: 'e',
      author: { ...author, username: '' },
    }), false)
    expect(dto).toMatchObject({
      kind: 'reply', parentId: 'parent', rootPostId: 'root', encrypted: true, quotedPostId: 'q',
      quoted: { id: 'Q'.repeat(44), content: 'quoted' },
      embed: { contractId: 'c', documentType: 'poll', id: 'e' },
      author: { username: null },
    })
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
