import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, requireKeyExchangeContract, requirePoolMatchesNetwork } from '../src/config'
import { bytesToHex } from '@noble/hashes/utils.js'
import { parsePool, selectPersona } from '../src/pool'
import { IDENTITY_ID, PERSONA_IDX, testPool, testPrivateKey } from './fixtures'

const SAKURA_ENV = `
NEXT_PUBLIC_NETWORK=devnet
NEXT_PUBLIC_DEVNET_NAME=test
NEXT_PUBLIC_DAPI_ADDRESSES=https://10.0.0.1:1443,10.0.0.2:1443
NEXT_PUBLIC_QUORUM_URL=https://quorums.test.example
`

function envFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'responder-config-')), '.env.devnet')
  writeFileSync(path, content)
  return path
}

describe('loadConfig', () => {
  it('reads the devnet wiring from the one env file it is given', () => {
    const config = loadConfig(envFile(SAKURA_ENV))
    expect(config.devnet).toEqual({
      devnetName: 'test',
      addresses: ['https://10.0.0.1:1443', 'https://10.0.0.2:1443'],
      quorumUrl: 'https://quorums.test.example',
    })
    expect(config.keyExchangeContractId).toBeUndefined()
  })

  it('fails the dash-key: path with a clear message while the key-exchange contract is unset', () => {
    const config = loadConfig(envFile(SAKURA_ENV))
    expect(() => requireKeyExchangeContract(config)).toThrow(/NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID is unset .* not published on devnet test yet/)
  })

  it('returns the key-exchange contract once it is set', () => {
    const id = '9UgRuCx9zKrpmCAGkr4QV5i8PViWABw28t7wCqHeap89'
    const config = loadConfig(envFile(`${SAKURA_ENV}\nNEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID=${id}\n`))
    expect(requireKeyExchangeContract(config)).toBe(id)
  })

  it('refuses a non-devnet env file and a pool for another devnet', () => {
    expect(() => loadConfig(envFile('NEXT_PUBLIC_NETWORK=testnet\n'))).toThrow(/only serves devnet/)
    const config = loadConfig(envFile(SAKURA_ENV.replace('DEVNET_NAME=test', 'DEVNET_NAME=bonsia-g1')))
    expect(() => requirePoolMatchesNetwork(testPool(), config)).toThrow(/pool is for devnet-test .* targets devnet-bonsia-g1/)
  })
})

describe('pool', () => {
  it('hands out keys by role and checks them against publicKeyHex', () => {
    const persona = selectPersona(testPool(), PERSONA_IDX)
    expect(persona.identityId).toBe(IDENTITY_ID)
    expect(persona.key('high').keyId).toBe(2)
    expect(bytesToHex(persona.key('master').privateKey)).toBe(bytesToHex(testPrivateKey(0)))
  })

  it('never puts key material in its errors', () => {
    const pool = testPool()
    const keys = pool.personas[0].identityKeys
    keys[1].publicKeyHex = keys[2].publicKeyHex
    const secret = keys[1].privateKeyHex
    const persona = selectPersona(pool, PERSONA_IDX)
    expect(() => persona.key('critical')).toThrow(/keyId 1: private key does not match publicKeyHex/)
    try {
      persona.key('critical')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
    expect(() => selectPersona(parsePool({ identities: [] }), 1)).toThrow(/Persona 1 is not in the pool/)
  })
})
