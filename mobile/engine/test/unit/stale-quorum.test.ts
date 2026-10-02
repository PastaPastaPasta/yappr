import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSdk = vi.hoisted(() => vi.fn())
vi.mock('@/lib/services/evo-sdk-service', () => ({ evoSdkService: { getSdk } }))

const { isStaleQuorumError, retryReadsOnStaleQuorum } = await import('../../src/api/stale-quorum')

// What wasm-sdk 5.0.0-beta.1 rejects with on sakura once a newer quorum signs.
const STALE = 'context provider error: invalid quorum: Quorum not found in cache for hash: 05c491ece943f1d35c6fe46ee83035399cf89b5e2b4b1249f3561713b1fe8827'

beforeEach(() => {
  getSdk.mockReset().mockResolvedValue({})
})

describe('isStaleQuorumError', () => {
  it('matches the stale-cache failure however it is shaped', () => {
    expect(isStaleQuorumError(new Error(STALE))).toBe(true)
    // wasm-bindgen errors are plain objects with a message.
    expect(isStaleQuorumError({ name: 'WasmSdkError', message: STALE })).toBe(true)
    expect(isStaleQuorumError(STALE)).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isStaleQuorumError(new Error('invalid quorum: bad signature'))).toBe(false)
    expect(isStaleQuorumError(new Error('no available addresses to retry'))).toBe(false)
    expect(isStaleQuorumError(undefined)).toBe(false)
  })
})

describe('retryReadsOnStaleQuorum', () => {
  it('passes results, other errors and non-function members straight through', async () => {
    const boom = new Error('Document not found')
    const module = {
      ok: vi.fn(async (n: number) => n * 2),
      fails: vi.fn(async () => { throw boom }),
      limit: 30,
    }
    const wrapped = retryReadsOnStaleQuorum(module)
    await expect(wrapped.ok(21)).resolves.toBe(42)
    await expect(wrapped.fails()).rejects.toBe(boom)
    expect(wrapped.limit).toBe(30)
    expect(module.fails).toHaveBeenCalledTimes(1)
    expect(getSdk).not.toHaveBeenCalled()
  })

  it('waits for the rebuilt SDK, then runs the call once more with the same arguments and this', async () => {
    const order: string[] = []
    let rebuilt = false
    getSdk.mockImplementation(async () => { order.push('getSdk'); rebuilt = true; return {} })
    const module = {
      async home(this: unknown, query: { tab: string }) {
        order.push(`home ${query.tab} ${this === module}`)
        if (!rebuilt) throw new Error(STALE)
        return { items: [1, 2] }
      },
    }
    await expect(retryReadsOnStaleQuorum(module).home({ tab: 'forYou' })).resolves.toEqual({ items: [1, 2] })
    expect(order).toEqual(['home forYou true', 'getSdk', 'home forYou true'])
  })

  it('retries only once', async () => {
    const read = vi.fn(async () => { throw new Error(STALE) })
    await expect(retryReadsOnStaleQuorum({ read }).read()).rejects.toThrow(/Quorum not found in cache/)
    expect(read).toHaveBeenCalledTimes(2)
    expect(getSdk).toHaveBeenCalledTimes(1)
  })

  it('reports the original failure when the rebuild fails, without retrying', async () => {
    const stale = new Error(STALE)
    getSdk.mockRejectedValue(new Error('Failed to prefetch quorums'))
    const read = vi.fn(async () => { throw stale })
    await expect(retryReadsOnStaleQuorum({ read }).read()).rejects.toBe(stale)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
