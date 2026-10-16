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

describe('starterClaimFromHistory', () => {
  it('reads a once-per-identity claim document as claimed', async () => {
    const { starterClaimFromHistory } = await load('v10')
    expect(starterClaimFromHistory([{ distributionType: 2 }], 20)).toBe('claimed')
    expect(starterClaimFromHistory([{ distributionType: 0 }, { distributionType: '2' }], 20)).toBe('claimed')
  })

  it('reads an empty or partial page without one as unclaimed', async () => {
    const { starterClaimFromHistory } = await load('v10')
    expect(starterClaimFromHistory([], 20)).toBe('unclaimed')
    expect(starterClaimFromHistory([{ distributionType: 1 }], 20)).toBe('unclaimed')
  })

  it('reads a full page without one as unknown, so no claim is offered', async () => {
    const { starterClaimFromHistory } = await load('v10')
    expect(starterClaimFromHistory([{ distributionType: 1 }, { distributionType: 0 }], 2)).toBe('unknown')
  })
})

describe('yappTopUp', () => {
  it('keeps buying YAPP on v2 and v9, whatever the claim state', async () => {
    for (const topology of ['v2', 'v9']) {
      const { yappTopUp } = await load(topology)
      for (const state of ['claimed', 'unclaimed', 'unknown'] as const) expect(yappTopUp(state)).toBe('buy')
    }
  })

  it('offers the starter grant on v10 only while chain says it is unclaimed (#740)', async () => {
    const { yappTopUp } = await load('v10')
    expect(yappTopUp('unclaimed')).toBe('claim')
    expect(yappTopUp('claimed')).toBeNull()
    // Fail closed: a failed or pending read never offers a claim that could be refused for a fee.
    expect(yappTopUp('unknown')).toBeNull()
  })
})
