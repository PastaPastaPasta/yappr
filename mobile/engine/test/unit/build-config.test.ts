import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import buildConfig from '../../build-config.cjs'

const root = path.resolve(__dirname, '../../../..')
const { variantConfig } = buildConfig

describe('native release configuration', () => {
  it('loads every staging public pin and records web prefix and epoch while preserving native storage keys', () => {
    const file = parseEnv(readFileSync(path.join(root, '.env.staging'), 'utf8'))
    const { env, webBasePath, storageEpoch, networkKey } = variantConfig(root, 'staging-testnet')
    for (const [key, value] of Object.entries(file).filter(([key]) => key.startsWith('NEXT_PUBLIC_'))) {
      expect(env[key]).toBe(value)
    }
    expect(env.NEXT_PUBLIC_BASE_PATH).toBe('')
    expect(webBasePath).toBe('/staging')
    expect(storageEpoch).toBe(file.STORAGE_EPOCH)
    expect(networkKey).toMatch(/^[\w.-]+$/)
    expect(env.NEXT_PUBLIC_STORAGE_SCOPE).toBe('')
    expect(env.STORAGE_EPOCH).toBeUndefined()
  })

  it('fails closed on absent and unfilled production pins, even when the file disables release mode', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'native-release-'))
    try {
      expect(() => variantConfig(dir, 'testnet')).toThrow('Complete the public release configuration')
      writeFileSync(path.join(dir, '.env.testnet'), 'NEXT_PUBLIC_RELEASE=0\nNEXT_PUBLIC_NETWORK=testnet\n')
      expect(() => variantConfig(dir, 'testnet')).toThrow('defaults are forbidden')
      writeFileSync(path.join(dir, '.env.testnet'), readFileSync(path.join(root, '.env.staging')))
      const config = variantConfig(dir, 'testnet')
      expect(config.env.NEXT_PUBLIC_BASE_PATH).toBe('')
      expect(config.env.NEXT_PUBLIC_STORAGE_SCOPE).toBe('')
      expect(config.networkKey).toMatch(/^[\w.-]+$/)
      expect(config.networkKey).not.toBe(variantConfig(root, 'staging-testnet').networkKey)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves explicit devnet config without requiring release pins', () => {
    const { env, networkKey } = variantConfig(root, 'devnet')
    expect(env.NEXT_PUBLIC_NETWORK).toBe('devnet')
    expect(env.NEXT_PUBLIC_BASE_PATH).toBe('')
    expect(env.NEXT_PUBLIC_STORAGE_SCOPE).toBe('')
    expect(networkKey).toBe('devnet-sakura')
    expect(networkKey).toMatch(/^[\w.-]+$/)
  })
})
