import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  reconnect: vi.fn(),
  ready: vi.fn(),
  error: vi.fn(),
  effect: undefined as undefined | (() => void | (() => void)),
}))

// Exercise the provider's actual effect and event listener with controlled SDK
// promises. Hook setters are recorded; no browser/network behavior is simulated.
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => [initial, initial === false ? mocks.ready : mocks.error],
  useEffect: (effect: () => void | (() => void)) => { mocks.effect = effect },
}))
vi.mock('@/lib/services/evo-sdk-service', () => ({
  evoSdkService: { initialize: mocks.initialize, reconnect: mocks.reconnect },
}))
vi.mock('@/lib/constants', () => ({
  YAPPR_CONTRACT_ID: 'contract', getConfiguredNetwork: () => 'devnet',
}))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn() } }))

import { SdkProvider } from '@/contexts/sdk-context'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let cleanup: (() => void) | void
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.unstubAllGlobals()
})

describe('SDK provider recovery state', () => {
  it.each(['success', 'failure'] as const)('ignores stale bootstrap %s while recovery is pending', async (outcome) => {
    const initial = deferred()
    const recovery = deferred()
    mocks.initialize.mockReturnValue(initial.promise)
    mocks.reconnect.mockReturnValue(recovery.promise)
    SdkProvider({ children: null })
    cleanup = mocks.effect?.()
    window.dispatchEvent(new Event('online'))
    expect(mocks.reconnect).toHaveBeenCalledOnce()
    expect(mocks.ready).not.toHaveBeenCalled()

    if (outcome === 'success') initial.resolve()
    else initial.reject(new Error('old offline bootstrap failed'))
    await Promise.resolve()
    expect(mocks.ready).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()

    recovery.resolve()
    await Promise.resolve()
    expect(mocks.ready.mock.calls).toEqual([[true]])
    expect(mocks.error.mock.calls).toEqual([[null]])
  })

  it('preserves bootstrap readiness through recovery failure/success and removes its listener on unmount', async () => {
    mocks.initialize.mockResolvedValue(undefined)
    const recovery = deferred()
    mocks.reconnect.mockReturnValue(recovery.promise)
    SdkProvider({ children: null })
    cleanup = mocks.effect?.()
    await Promise.resolve()
    window.dispatchEvent(new Event('online'))
    recovery.reject(new Error('connection still unavailable'))
    await Promise.resolve()
    expect(mocks.error.mock.calls).toEqual([[null], ['connection still unavailable']])
    expect(mocks.ready.mock.calls).toEqual([[true]])

    mocks.reconnect.mockResolvedValue(undefined)
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    expect(mocks.error.mock.calls).toEqual([[null], ['connection still unavailable'], [null]])
    expect(mocks.ready.mock.calls).toEqual([[true], [true]])

    cleanup?.()
    cleanup = undefined
    window.dispatchEvent(new Event('online'))
    expect(mocks.reconnect).toHaveBeenCalledTimes(2)
  })
})
