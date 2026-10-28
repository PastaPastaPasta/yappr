import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import { parseAppConnectCarriers, parseAppConnectPins, parseLoginProtocol } from './config'

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

describe('parseAppConnectCarriers', () => {
  it('keeps dash-key: on testnet and devnet unless dashpay or both is asked for', () => {
    for (const network of ['testnet', 'devnet'] as const) {
      expect(parseAppConnectCarriers(undefined, network)).toEqual(['dash-key'])
      expect(parseAppConnectCarriers('', network)).toEqual(['dash-key'])
      expect(parseAppConnectCarriers('dash-key', network)).toEqual(['dash-key'])
      expect(parseAppConnectCarriers('bogus', network)).toEqual(['dash-key'])
      expect(parseAppConnectCarriers(' dashpay ', network)).toEqual(['dashpay'])
    }
  })

  it('offers both on testnet and devnet, dash-key: first (what current wallets accept)', () => {
    for (const network of ['testnet', 'devnet'] as const) {
      expect(parseAppConnectCarriers('both', network)).toEqual(['dash-key', 'dashpay'])
      expect(parseAppConnectCarriers(' both ', network)).toEqual(['dash-key', 'dashpay'])
    }
  })

  it('is always dashpay alone on mainnet, both refused', () => {
    for (const value of [undefined, '', 'dash-key', 'dashpay', 'both']) {
      expect(parseAppConnectCarriers(value, 'mainnet')).toEqual(['dashpay'])
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
