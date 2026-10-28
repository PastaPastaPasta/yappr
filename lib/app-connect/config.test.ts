import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import { parseAppConnectCarrier, parseAppConnectPins, parseLoginProtocol } from './config'

const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const APP = id(1)
const GROUP = id(2)
const OWNER = id(3)
const SOCIAL = id(4)

describe('parseLoginProtocol', () => {
  it('is legacy unless app-connect is asked for', () => {
    expect(parseLoginProtocol(undefined)).toBe('legacy')
    expect(parseLoginProtocol('')).toBe('legacy')
    expect(parseLoginProtocol('legacy')).toBe('legacy')
    expect(parseLoginProtocol('App-Connect')).toBe('legacy')
    expect(parseLoginProtocol(' app-connect ')).toBe('app-connect')
  })
})

describe('parseAppConnectCarrier', () => {
  it('keeps dash-key: on testnet and devnet unless dashpay is asked for', () => {
    for (const network of ['testnet', 'devnet'] as const) {
      expect(parseAppConnectCarrier(undefined, network)).toBe('dash-key')
      expect(parseAppConnectCarrier('', network)).toBe('dash-key')
      expect(parseAppConnectCarrier('dash-key', network)).toBe('dash-key')
      expect(parseAppConnectCarrier('bogus', network)).toBe('dash-key')
      expect(parseAppConnectCarrier(' dashpay ', network)).toBe('dashpay')
    }
  })

  it('is always dashpay on mainnet', () => {
    for (const value of [undefined, '', 'dash-key', 'dashpay']) {
      expect(parseAppConnectCarrier(value, 'mainnet')).toBe('dashpay')
    }
  })
})

describe('parseAppConnectPins', () => {
  const env = { appId: APP, groupId: GROUP, groupOwner: OWNER, members: `${APP},${SOCIAL}` }

  it('pins every member at version 1 unless a version is given', () => {
    expect(parseAppConnectPins(env)).toEqual({
      appId: APP,
      groupId: GROUP,
      groupOwner: OWNER,
      members: [{ contractId: APP, version: 1 }, { contractId: SOCIAL, version: 1 }],
    })
    expect(parseAppConnectPins({ ...env, members: `${APP}, ${SOCIAL}:2` })?.members[1]).toEqual({ contractId: SOCIAL, version: 2 })
  })

  it('is null when anything is missing or malformed', () => {
    expect(parseAppConnectPins({})).toBeNull()
    expect(parseAppConnectPins({ ...env, groupOwner: '' })).toBeNull()
    expect(parseAppConnectPins({ ...env, groupId: 'not-an-id' })).toBeNull()
    expect(parseAppConnectPins({ ...env, members: `${APP},xyz` })).toBeNull()
    expect(parseAppConnectPins({ ...env, members: `${APP},${SOCIAL}:0` })).toBeNull()
    expect(parseAppConnectPins({ ...env, members: `${APP},${SOCIAL}:1:2` })).toBeNull()
  })

  it('requires the anchor among the members and no member twice', () => {
    expect(parseAppConnectPins({ ...env, members: SOCIAL })).toBeNull()
    expect(parseAppConnectPins({ ...env, members: `${APP},${SOCIAL},${SOCIAL}:2` })).toBeNull()
  })
})
