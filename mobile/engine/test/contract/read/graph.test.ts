import { expect, it } from 'vitest'
import { page, userSummaryDTO } from '../../../src/dto/validate'
import { describeRead, engine, expectCode, expectValid, namedAuthor, timed } from './harness'

describeRead('graph', 'graph', () => {
  it('pages followers and following with names and counts, matching the profile stats', async () => {
    const { id } = await namedAuthor()
    const profile = await engine.profiles.get(id)
    for (const kind of ['followers', 'following'] as const) {
      const list = await timed(`graph.${kind}`, () => engine.graph[kind](id))
      expectValid(page(userSummaryDTO), list, kind)
      expect(list.items.length).toBe(Math.min(profile?.stats[kind] ?? 0, 30))
      for (const user of list.items) {
        expect(user.followers).toEqual(expect.any(Number))
        expect(user.viewerFollows).toBeUndefined()
      }
      if (list.cursor) expectValid(page(userSummaryDTO), await engine.graph[kind](id, list.cursor), `${kind}2`)
    }
  })

  it('needs a session for follow status', async () => {
    await expectCode(engine.graph.status([(await namedAuthor()).id]), 'NOT_SIGNED_IN')
  })
})
