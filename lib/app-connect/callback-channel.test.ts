import { describe, expect, it } from 'vitest'
import { appReturnLink, isConnectCallbackAck, isConnectCallbackMessage, parseConnectCallback } from './callback-channel'

const HASH = 'ab'.repeat(20)

describe('parseConnectCallback', () => {
  it('reads the request hash and the wallet status', () => {
    expect(parseConnectCallback(`?r=${HASH}&ac=ok`)).toEqual({ requestHash: HASH, status: 'ok', app: null })
    expect(parseConnectCallback(`?r=${HASH.toUpperCase()}`)).toEqual({ requestHash: HASH, status: null, app: null })
  })

  it('names the Yappr app that made the request, and no other scheme', () => {
    expect(parseConnectCallback(`?r=${HASH}&app=yappr-dev&ac=ok`)).toEqual({ requestHash: HASH, status: 'ok', app: 'yappr-dev' })
    for (const app of ['javascript', 'https', 'yappr-devx', 'YAPPR', '']) {
      expect(parseConnectCallback(`?r=${HASH}&app=${encodeURIComponent(app)}`)?.app).toBeNull()
    }
  })

  it('ignores anything that is not a request hash, and odd statuses', () => {
    expect(parseConnectCallback('?r=abc')).toBeNull()
    expect(parseConnectCallback('')).toBeNull()
    expect(parseConnectCallback(`?r=${HASH}&ac=<script>`)).toEqual({ requestHash: HASH, status: null, app: null })
  })
})

describe('appReturnLink', () => {
  it('hands back only the request hash and the status', () => {
    expect(appReturnLink({ requestHash: HASH, status: 'declined', app: 'yappr-dev' })).toBe(`yappr-dev://connect?r=${HASH}&ac=declined`)
    expect(appReturnLink({ requestHash: HASH, status: null, app: 'yappr-beta' })).toBe(`yappr-beta://connect?r=${HASH}`)
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
