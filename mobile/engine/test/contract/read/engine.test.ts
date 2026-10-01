import { expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../../src/protocol/envelope'
import { describeRead, engine, expectCode, EXPECTED, timed } from './harness'

describeRead('engine', 'engine', () => {
  it('boots once and reports the wiring, capabilities, gateways and avatar styles', async () => {
    const info = await timed('engine.info', () => engine.engine.info())
    expect(info).toMatchObject({ protocol: PROTOCOL_VERSION, network: EXPECTED.network, topology: EXPECTED.topology, ready: true, webAssembly: true })
    expect(info.contracts.social).toBe(EXPECTED.social)
    expect(info.bootMs).toBeGreaterThan(0)
    expect((await engine.engine.boot()).bootMs).toBe(info.bootMs)

    const caps = info.capabilities
    expect(caps.contentLimits.chars).toBeGreaterThan(0)
    expect(caps.profileLimits.displayName).toBeGreaterThan(0)
    if (info.topology === 'v2') {
      // The production testnet contract: no rankings, no quote slots, polymorphic replies.
      expect(caps).toMatchObject({
        rankings: false, windowedRankings: false, repostsAreQuotes: false, flatThreads: false, postLanguage: true,
        contentLimits: { chars: 500, bytes: null }, repostable: { post: true, reply: true },
      })
    }
    if (caps.repostsAreQuotes) expect(caps.rankings).toBe(true)

    expect(info.ipfsGateways.length).toBeGreaterThan(0)
    for (const gateway of info.ipfsGateways) expect(['path', 'subdomain']).toContain(gateway.format)
    expect(info.avatarStyles.styles.map(style => style.id)).toContain(info.avatarStyles.defaultStyle)
    expect(info.avatarStyles.styles.every(style => style.label.length > 0)).toBe(true)
    expect(info.avatarStyles.seedMaxLength).toBeGreaterThan(0)
  })

  it('rejects unknown methods and foreign cursors with typed errors', async () => {
    const api = engine as unknown as { feed: { nope(): Promise<unknown> } }
    await expectCode(api.feed.nope(), 'UNKNOWN_METHOD')
    await expectCode(engine.feed.home({ tab: 'forYou', cursor: 'garbage' }), 'BAD_CURSOR')
  })
})
