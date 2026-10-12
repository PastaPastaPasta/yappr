import { describe, expect, it } from 'vitest'
import { isConnectCallbackAck, isConnectCallbackMessage, parseConnectCallback } from './callback-channel'

const HASH = 'ab'.repeat(20)

describe('parseConnectCallback', () => {
  it('reads the request hash and the wallet status', () => {
    expect(parseConnectCallback(`?r=${HASH}&ac=ok`)).toEqual({ requestHash: HASH, status: 'ok' })
    expect(parseConnectCallback(`?r=${HASH.toUpperCase()}`)).toEqual({ requestHash: HASH, status: null })
  })

  it('ignores anything that is not a request hash, and odd statuses', () => {
    expect(parseConnectCallback('?r=abc')).toBeNull()
    expect(parseConnectCallback('')).toBeNull()
    expect(parseConnectCallback(`?r=${HASH}&ac=<script>`)).toEqual({ requestHash: HASH, status: null })
  })
})

describe('channel messages', () => {
  it('accept only well-formed messages for the right request', () => {
    expect(isConnectCallbackMessage({ type: 'app-connect-callback', requestHash: HASH, status: 'ok' })).toBe(true)
    expect(isConnectCallbackMessage({ type: 'app-connect-callback', requestHash: 'x' })).toBe(false)
    expect(isConnectCallbackMessage('app-connect-callback')).toBe(false)
    expect(isConnectCallbackAck({ type: 'app-connect-callback-ack', requestHash: HASH }, HASH)).toBe(true)
    expect(isConnectCallbackAck({ type: 'app-connect-callback-ack', requestHash: 'cd'.repeat(20) }, HASH)).toBe(false)
  })
})
