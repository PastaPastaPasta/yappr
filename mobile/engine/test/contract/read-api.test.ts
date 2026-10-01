/**
 * Engine contract tests: the engine API, from source, in Node, against the
 * live network, through the same dispatcher + client + codec the WebView uses
 * (an in-process transport replaces the bridge). Read only and
 * unauthenticated, so they run on every engine PR.
 *
 * Target: testnet, the production yap.pr contracts (topology v2). The Rust
 * engine has to pass this same suite later.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { createEngineApi, type EngineApi, type PostDTO } from '../../src/api'
import { createDispatcher } from '../../src/rpc/dispatcher'
import { createEngineClient } from '../../src/rpc/client'
import { createInProcessPair } from '../../src/rpc/transport'
import { PROTOCOL_VERSION } from '../../src/protocol/envelope'

const [hostSide, engineSide] = createInProcessPair()
const dispatcher = createDispatcher({ api: createEngineApi(), transport: engineSide })
const client = createEngineClient<EngineApi>(hostSide, { timeoutMs: 120_000 })
dispatcher.hello({ bundleHash: 'node' })
const engine = client.api

let firstPage: PostDTO[] = []

describe('engine read API on testnet', () => {
  beforeAll(async () => {
    const hello = await client.ready
    expect(hello.protocol).toBe(PROTOCOL_VERSION)
  })

  it('boots and reports the production wiring', async () => {
    const info = await engine.engine.boot()
    expect(info).toMatchObject({
      protocol: PROTOCOL_VERSION,
      network: 'testnet',
      topology: 'v2',
      ready: true,
      webAssembly: true,
    })
    expect(info.contracts.social).toBe('9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9')
    expect(info.evoSdkVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(info.bootMs).toBeGreaterThan(0)
    // A second boot shares the first.
    expect((await engine.engine.boot()).bootMs).toBe(info.bootMs)
  })

  it('reads the first For You page with authors and stats', async () => {
    const page = await engine.feed.forYou()
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.cursor).toEqual(expect.any(String))
    for (const post of page.items) {
      expect(post.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
      expect(post.createdAt).toBeInstanceOf(Date)
      expect(post.author.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
      expect(post.author.avatarUrl).not.toBe('')
      expect(post.stats).toEqual({
        likes: expect.any(Number), reposts: expect.any(Number), replies: expect.any(Number), quotes: expect.any(Number),
      })
      // Signed out: no viewer marks.
      expect(post.viewer).toBeUndefined()
    }
    // Most testnet authors have a DPNS name; the batch must have resolved some.
    expect(page.items.some(post => post.author.username)).toBe(true)
    firstPage = page.items
  })

  it('pages with the cursor, without repeating the first page', async (ctx) => {
    const first = await engine.feed.forYou()
    // Testnet holds only a couple of `en` posts since the August rollback.
    // Asking past the end is not exercised: evo-sdk 4.2.0-beta.7 fails proof
    // verification on an empty desc page (see README, "SDK bugs").
    if (!first.hasMore) ctx.skip()
    const second = await engine.feed.forYou({ cursor: first.cursor })
    const firstIds = new Set(first.items.map(post => post.id))
    expect(second.items.every(post => !firstIds.has(post.id))).toBe(true)
  })

  it('gets one post by id', async () => {
    const sample = firstPage[0]
    const post = await engine.posts.get(sample.id)
    expect(post).not.toBeNull()
    expect(post).toMatchObject({ id: sample.id, content: sample.content, author: { id: sample.author.id } })
  })

  it('returns null for a post that does not exist', async () => {
    expect(await engine.posts.get('11111111111111111111111111111111111111111111')).toBeNull()
  })

  it('gets a profile by identity id and by DPNS name', async () => {
    const named = firstPage.find(post => post.author.username)
    expect(named).toBeDefined()
    const byId = await engine.profiles.get(named!.author.id)
    expect(byId).toMatchObject({ id: named!.author.id, username: named!.author.username })
    expect(byId!.usernames).toContain(named!.author.username)
    expect(byId!.stats).toEqual({ posts: expect.any(Number), followers: expect.any(Number), following: expect.any(Number) })
    expect(byId!.stats.posts).toBeGreaterThan(0)

    const byName = await engine.profiles.get(`@${named!.author.username}.dash`)
    expect(byName?.id).toBe(named!.author.id)
  })

  it('returns null for a DPNS name nobody holds', async () => {
    expect(await engine.profiles.get('no-such-yappr-user-zz9-plural-z-alpha')).toBeNull()
  })

  it('rejects unknown methods with a typed error', async () => {
    const api = engine as unknown as { feed: { nope(): Promise<unknown> } }
    await expect(api.feed.nope()).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' })
  })
})
