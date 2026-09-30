import { beforeEach, describe, expect, it, vi } from 'vitest'

async function load(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./starter-grant')
}

let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
})

describe('starter grant settlement', () => {
  it('remembers each claimed identity once, under the key the e2e fixtures pre-seed', async () => {
    const { isStarterGrantSettled, markStarterGrantSettled } = await load('v10')
    expect(isStarterGrantSettled('alice')).toBe(false)
    markStarterGrantSettled('alice')
    markStarterGrantSettled('alice')
    markStarterGrantSettled('bob')
    expect(isStarterGrantSettled('alice')).toBe(true)
    expect(isStarterGrantSettled('carol')).toBe(false)
    expect(JSON.parse(storage.get('yappr_starter_grant_settled') ?? '')).toEqual(['alice', 'bob'])
  })

  it('treats a corrupt or foreign value as nothing settled', async () => {
    const { isStarterGrantSettled, markStarterGrantSettled } = await load('v10')
    storage.set('yappr_starter_grant_settled', '{not json')
    expect(isStarterGrantSettled('alice')).toBe(false)
    storage.set('yappr_starter_grant_settled', JSON.stringify([7, 'alice', null]))
    expect(isStarterGrantSettled('alice')).toBe(true)
    markStarterGrantSettled('bob')
    expect(JSON.parse(storage.get('yappr_starter_grant_settled') ?? '')).toEqual(['alice', 'bob'])
  })
})

describe('yappTopUp', () => {
  it('keeps buying YAPP on v2 and v9, claimed grant or not', async () => {
    for (const topology of ['v2', 'v9']) {
      const { markStarterGrantSettled, yappTopUp } = await load(topology)
      expect(yappTopUp('alice')).toBe('buy')
      markStarterGrantSettled('alice')
      expect(yappTopUp('alice')).toBe('buy')
    }
  })

  it('offers only the starter grant on v10, and nothing once it is claimed', async () => {
    const { markStarterGrantSettled, yappTopUp } = await load('v10')
    expect(yappTopUp('alice')).toBe('claim')
    markStarterGrantSettled('alice')
    expect(yappTopUp('alice')).toBeNull()
    expect(yappTopUp('bob')).toBe('claim')
  })
})
