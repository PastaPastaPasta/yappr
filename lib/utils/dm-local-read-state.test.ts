import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let storage: Map<string, string>

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STORAGE_SCOPE', 'devnet')
  vi.stubEnv('NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID', 'qa-contract')
  storage = new Map()
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('browser-local message read state', () => {
  it('retains only confirmed incoming message IDs across a fresh module load', async () => {
    const { markMessagesReadLocally } = await import('./dm-local-read-state')
    markMessagesReadLocally('viewer', 'conversation', [
      { id: 'received', senderId: 'other', createdAt: new Date(1000) },
      { id: 'sent', senderId: 'viewer', createdAt: new Date(1000) },
      { id: 'temp-pending', senderId: 'other', createdAt: new Date(1000) },
    ])
    vi.resetModules()
    const { getLocallyReadMessageIds } = await import('./dm-local-read-state')
    expect([...getLocallyReadMessageIds('viewer', 'conversation')]).toEqual(['received'])
    expect([...storage.keys()]).toEqual(['devnet:yappr_dm_read:qa-contract:viewer:conversation'])
  })

  it('does not share read state between users, conversations, contracts, or deployments', async () => {
    const local = await import('./dm-local-read-state')
    local.markMessagesReadLocally('viewer', 'conversation', [{ id: 'received', senderId: 'other', createdAt: new Date(1000) }])
    expect(local.getLocallyReadMessageIds('other-viewer', 'conversation').size).toBe(0)
    expect(local.getLocallyReadMessageIds('viewer', 'other-conversation').size).toBe(0)
    vi.stubEnv('NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID', 'other-contract')
    vi.resetModules()
    expect((await import('./dm-local-read-state')).getLocallyReadMessageIds('viewer', 'conversation').size).toBe(0)
    vi.stubEnv('NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID', 'qa-contract')
    vi.stubEnv('NEXT_PUBLIC_STORAGE_SCOPE', 'testnet')
    vi.resetModules()
    expect((await import('./dm-local-read-state')).getLocallyReadMessageIds('viewer', 'conversation').size).toBe(0)
  })

  it('bounds stored history while keeping the newest confirmed IDs', async () => {
    const local = await import('./dm-local-read-state')
    local.markMessagesReadLocally('viewer', 'conversation', Array.from({ length: 1005 }, (_, i) => ({ id: `received-${i}`, senderId: 'other', createdAt: new Date(1000 + i) })))
    const ids = local.getLocallyReadMessageIds('viewer', 'conversation')
    expect(ids.size).toBe(1000)
    expect(ids.has('received-0')).toBe(false)
    expect(ids.has('received-1004')).toBe(true)
  })

  it('does not evict recent read IDs when old conversation pages are replayed', async () => {
    const local = await import('./dm-local-read-state')
    const page = (start: number, length: number) => Array.from({ length }, (_, i) => ({
      id: `received-${start + i}`, senderId: 'other', createdAt: new Date(1000 + start + i),
    }))
    local.markMessagesReadLocally('viewer', 'conversation', page(1000, 1000))
    const recent = local.getLocallyReadMessageIds('viewer', 'conversation')
    local.markMessagesReadLocally('viewer', 'conversation', page(0, 100))
    expect(local.getLocallyReadMessageIds('viewer', 'conversation')).toEqual(recent)
    local.markMessagesReadLocally('viewer', 'conversation', page(100, 900))
    expect(local.getLocallyReadMessageIds('viewer', 'conversation')).toEqual(recent)
    local.markMessagesReadLocally('viewer', 'conversation', page(2000, 1))
    const updated = local.getLocallyReadMessageIds('viewer', 'conversation')
    expect(updated.size).toBe(1000)
    expect(updated.has('received-1000')).toBe(false)
    expect(updated.has('received-2000')).toBe(true)
  })

  it('tolerates unavailable or invalid browser storage', async () => {
    storage.set('devnet:yappr_dm_read:qa-contract:viewer:conversation', '{invalid')
    const local = await import('./dm-local-read-state')
    expect(local.getLocallyReadMessageIds('viewer', 'conversation').size).toBe(0)
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage unavailable') },
      setItem: () => { throw new Error('storage unavailable') },
    })
    expect(() => local.markMessagesReadLocally('viewer', 'conversation', [{ id: 'received', senderId: 'other', createdAt: new Date(1000) }])).not.toThrow()
    expect(local.getLocallyReadMessageIds('viewer', 'conversation').size).toBe(0)
  })
})
