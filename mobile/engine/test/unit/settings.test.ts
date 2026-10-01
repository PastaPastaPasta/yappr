import { describe, expect, it } from 'vitest'

// lib/store's persisted settings hydrate from storage when the module loads.
const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
const engineStorage = createEngineStorage()
engineStorage.hydrate({ local: { 'yappr-settings': JSON.stringify({ state: { sensitiveContentMode: 'hide', feedLanguage: 'de' }, version: 1 }) } })
installEngineStorage(engineStorage)
const { settings } = await import('../../src/api/settings')

describe('settings', () => {
  it('reads the persisted web settings, with web defaults for the rest', async () => {
    expect(await settings.get()).toEqual({
      linkPreviewsEnabled: true,
      gateMediaFromNonFollowed: true,
      sendReadReceipts: true,
      sensitiveContentMode: 'hide',
      notificationSettings: { likes: true, reposts: true, replies: true, follows: true, mentions: true, messages: true, blogPosts: true },
      payWith: 'yapp',
      feedLanguage: 'de',
    })
  })

  it('writes through lib\'s store, so the change persists for the next boot', async () => {
    const next = await settings.set({ sensitiveContentMode: 'blur', gateMediaFromNonFollowed: false, notificationSettings: { likes: false }, feedLanguage: 'pt' })
    expect(next).toMatchObject({ sensitiveContentMode: 'blur', gateMediaFromNonFollowed: false, feedLanguage: 'pt' })
    expect(next.notificationSettings).toMatchObject({ likes: false, reposts: true })
    const persisted = JSON.parse(engineStorage.snapshot().local['yappr-settings']).state
    expect(persisted).toMatchObject({ sensitiveContentMode: 'blur', gateMediaFromNonFollowed: false, feedLanguage: 'pt', notificationSettings: { likes: false } })
  })

  it.each([
    [{ sensitiveContentMode: 'nsfw' }],
    [{ linkPreviewsEnabled: 'yes' }],
    [{ notificationSettings: { likes: 1 } }],
    [{ notificationSettings: { potato: true } }],
    [{ feedLanguage: '<script>' }],
    [{ potatoMode: true }],
  ])('refuses %j and changes nothing', async (patch) => {
    const before = await settings.get()
    await expect(settings.set({ sendReadReceipts: false, ...(patch as object) } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(await settings.get()).toEqual(before)
  })

  it('refuses a patch that is not an object', async () => {
    await expect(settings.set(null as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
