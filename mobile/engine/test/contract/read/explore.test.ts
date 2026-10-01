import { expect, it } from 'vitest'
import { array, postDTO, rankedUserDTO, tagDTO, userSummaryDTO } from '../../../src/dto/validate'
import { capabilities, describeRead, engine, expectCode, expectValid, namedAuthor, sampleFeed, timed } from './harness'

describeRead('explore', 'explore', () => {
  it('lists trending tags, counted by likes where rankings exist', async () => {
    const trending = await timed('explore.trending', () => engine.explore.trending())
    expectValid(array(tagDTO), trending, 'trending')
    expect(trending.length).toBeLessThanOrEqual(12)
    const caps = await capabilities()
    for (const tag of trending) expect(tag.countKind).toBe(caps.prefixRankings ? 'likes' : 'posts')
  })

  it('serves Top posts and creators only where rankings exist', async () => {
    const caps = await capabilities()
    if (caps.rankings) expectValid(array(postDTO), await timed('explore.topPosts', () => engine.explore.topPosts()), 'top')
    else await expectCode(engine.explore.topPosts(), 'NOT_SUPPORTED')
    if (caps.prefixRankings) expectValid(array(rankedUserDTO), await timed('explore.topCreators', () => engine.explore.topCreators()), 'creators')
    else await expectCode(engine.explore.topCreators(), 'NOT_SUPPORTED')
  })

  it('searches users by name prefix from 3 characters', async () => {
    const { id, username } = await namedAuthor()
    expect(await engine.explore.searchUsers(username.slice(0, 2))).toEqual([])
    const users = await timed('explore.searchUsers', () => engine.explore.searchUsers(username))
    expectValid(array(userSummaryDTO), users, 'users')
    expect(users.map(user => user.id)).toContain(id)
  })

  it('searches tags and recent posts', async () => {
    const tags = await timed('explore.searchHashtags', () => engine.explore.searchHashtags('#yappr'))
    expectValid(array(tagDTO), tags, 'tags')
    const sample = (await sampleFeed())[0]
    const word = sample.content.split(/\s+/).find(part => part.length >= 4) ?? sample.content
    const posts = await timed('explore.searchPosts', () => engine.explore.searchPosts(word))
    expectValid(array(postDTO), posts, 'posts')
    expect(posts.every(post => post.content.toLowerCase().includes(word.toLowerCase()))).toBe(true)
    expect(posts.map(post => post.id)).toContain(sample.id)
  })
})
