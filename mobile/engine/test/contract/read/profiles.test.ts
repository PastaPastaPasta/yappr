import { expect, it } from 'vitest'
import { page, postDTO, profileDTO, profileReplyDTO, userSummaryDTO } from '../../../src/dto/validate'
import { capabilities, describeRead, engine, expectCode, expectValid, namedAuthor, sampleFeed, timed, tooMany } from './harness'

describeRead('profiles', 'profiles', () => {
  it('gets a profile by identity id and by DPNS name', async () => {
    const { id, username } = await namedAuthor()
    const byId = await timed('profiles.get id', () => engine.profiles.get(id))
    expectValid(profileDTO, byId, 'profile')
    expect(byId).toMatchObject({ id, username })
    expect(byId?.usernames).toContain(username)
    expect(byId?.stats.posts).toBeGreaterThan(0)
    expect(byId?.viewer).toBeUndefined()
    const byName = await timed('profiles.get name', () => engine.profiles.get(`@${username}.dash`))
    expect(byName?.id).toBe(id)
    expect(await engine.profiles.get('no-such-yappr-user-zz9-plural-z-alpha')).toBeNull()
  })

  it('reads the Posts tab with the author\'s feed posts, newest activity first', async () => {
    const { id } = await namedAuthor()
    const posts = await timed('profiles.posts posts', () => engine.profiles.posts({ id, tab: 'posts' }))
    expectValid(page(postDTO), posts, 'posts')
    const own = (await sampleFeed()).filter(post => post.author.id === id && !post.repostedBy).map(post => post.id)
    for (const postId of own) expect(posts.items.map(post => post.id)).toContain(postId)
    for (const post of posts.items) expect(post.author.id === id || post.repostedBy?.id === id).toBe(true)
  })

  it('reads the Replies tab with each reply\'s parent, and the Mentions tab', async () => {
    const { id } = await namedAuthor()
    const replies = await timed('profiles.posts replies', () => engine.profiles.posts({ id, tab: 'replies' }))
    expectValid(page(profileReplyDTO), replies, 'replies')
    for (const reply of replies.items) expect(reply).toMatchObject({ kind: 'reply', author: { id } })
    const mentions = await timed('profiles.posts mentions', () => engine.profiles.posts({ id, tab: 'mentions' }))
    expectValid(page(postDTO), mentions, 'mentions')
  })

  it('serves the Top tab only where rankings exist', async () => {
    const { id } = await namedAuthor()
    const caps = await capabilities()
    if (!caps.rankings) {
      await expectCode(engine.profiles.posts({ id, tab: 'top' }), 'NOT_SUPPORTED')
      return
    }
    expectValid(page(postDTO), await timed('profiles.posts top', () => engine.profiles.posts({ id, tab: 'top' })), 'top')
  })

  it('batches user rows in the order asked', async () => {
    const ids = Array.from(new Set((await sampleFeed()).map(post => post.author.id)))
    const users = await timed('profiles.batch', () => engine.profiles.batch(ids))
    expect(users.map(user => user.id)).toEqual(ids)
    for (const user of users) expectValid(userSummaryDTO, user, 'user')
    await expectCode(engine.profiles.batch(tooMany(String)), 'BAD_REQUEST')
  })

  it('renders DiceBear avatars as SVG for the host', async () => {
    const { id } = await namedAuthor()
    const profile = await engine.profiles.get(id)
    const own = await timed('profiles.avatarSvg', () => engine.profiles.avatarSvg(id))
    if (profile?.avatar.dicebear) expect(own).toMatch(/^<svg/)
    else expect(own).toBeNull()
    const preview = await engine.profiles.avatarSvg(id, 'bottts', 'seed-1')
    expect(preview).toMatch(/^<svg/)
    expect(await engine.profiles.avatarSvg(id, 'bottts', 'seed-1')).toBe(preview)
    await expectCode(engine.profiles.avatarSvg(id, 'not-a-style', 'x'), 'BAD_REQUEST')
  })
})
