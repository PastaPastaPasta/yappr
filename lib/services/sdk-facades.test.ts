import { describe, expect, it } from 'vitest'
import { EvoSDK } from '@dashevo/evo-sdk'
import { SDK_FACADES } from './sdk-facades'

describe('SDK_FACADES', () => {
  it('lists every facade the installed EvoSDK constructs', () => {
    const sdk = new EvoSDK({ network: 'testnet' }) as unknown as Record<string, unknown>
    const constructed = Object.keys(sdk).filter(name => {
      const value = sdk[name]
      return typeof value === 'object' && value !== null &&
        (Object.getPrototypeOf(value) as { constructor?: { name?: string } }).constructor?.name?.endsWith('Facade')
    })
    expect(constructed.length).toBeGreaterThan(0)
    expect([...SDK_FACADES].sort()).toEqual(constructed.sort())
  })
})
