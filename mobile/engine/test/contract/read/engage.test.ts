import { expect, it } from 'vitest'
import { engageStatsDTO, record } from '../../../src/dto/validate'
import { describeRead, engine, expectCode, expectValid, sampleFeed, timed, tooMany } from './harness'

describeRead('engage', 'engage', () => {
  it('reads fresh counts anonymously, matching the feed\'s', async () => {
    const posts = await sampleFeed()
    const stats = await timed('engage.stats', () => engine.engage.stats(posts.map(post => ({ id: post.id, kind: post.kind }))))
    expectValid(record(engageStatsDTO), stats, 'stats')
    for (const post of posts) expect(stats[post.id]).toEqual({ stats: post.stats })
    await expectCode(engine.engage.stats(tooMany(i => ({ id: String(i), kind: 'post' as const }))), 'BAD_REQUEST')
  })
})
