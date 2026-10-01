import { describe, expect, it } from 'vitest'
import { errorMessage, isTimeout } from '../src/errors'

/** wasm-sdk rejects with objects that are not `Error`s and stringify to "[object Object]". */
function wasmError(message: string, code?: number): object {
  return Object.assign(Object.create({ toString: Object.prototype.toString }), { message, ...(code === undefined ? {} : { code }) })
}

describe('errors', () => {
  it('reads the message of a non-Error wasm error', () => {
    expect(String(wasmError('x'))).toBe('[object Object]')
    expect(errorMessage(wasmError('gateway deadline exceeded'))).toBe('gateway deadline exceeded')
  })

  it('treats a wasm gateway timeout as a timeout, but never a consensus refusal', () => {
    expect(isTimeout(wasmError('Timeout waiting for result'))).toBe(true)
    expect(isTimeout(new Error('HTTP 504 Gateway Timeout'))).toBe(true)
    expect(isTimeout(wasmError('state transition expired: timeout', 40140))).toBe(false)
    expect(isTimeout(wasmError('nonce 15040 out of bounds'))).toBe(false)
  })
})
