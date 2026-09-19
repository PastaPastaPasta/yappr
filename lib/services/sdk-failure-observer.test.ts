import { describe, expect, it, vi } from 'vitest'
import { observeSdkFailures } from './sdk-failure-observer'

describe('observeSdkFailures', () => {
  it('leaves synchronous values, streams, receiver binding and fulfilled promises alone', async () => {
    const stream = { [Symbol.asyncIterator]: async function* () { yield 1 } }
    class Facade {
      label = 'same receiver'
      local() { return this.label }
      stream() { return stream }
      async read() { return this.label }
    }
    const facade = new Facade()
    const onFailure = vi.fn()
    observeSdkFailures([facade], onFailure)
    expect(facade.local()).toBe('same receiver')
    expect(facade.stream()).toBe(stream)
    await expect(facade.read()).resolves.toBe('same receiver')
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('reports a rejection, rethrows it unchanged and never repeats the call', async () => {
    const original = new Error('transport failure')
    const operation = vi.fn().mockRejectedValue(original)
    const facade = { operation }
    const onFailure = vi.fn(() => { throw new Error('report failed') })
    observeSdkFailures([facade], onFailure)
    await expect(facade.operation()).rejects.toBe(original)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(original)
  })

  it('does not wait for anything the report starts', async () => {
    const failure = new Error('failure')
    const facade = { operation: vi.fn().mockRejectedValue(failure) }
    const rebuild = new Promise<void>(() => undefined)
    observeSdkFailures([facade], () => { rebuild.catch(() => undefined) })
    await expect(facade.operation()).rejects.toBe(failure)
  })
})
