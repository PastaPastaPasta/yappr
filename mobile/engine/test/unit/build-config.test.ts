import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import buildConfig from '../../build-config.cjs'

const root = path.resolve(__dirname, '../../../..')
const { variantConfig } = buildConfig

describe('native release configuration', () => {
  it.each([
    { variant: 'testnet', webBasePath: '' },
    { variant: 'staging-testnet', webBasePath: '/staging' },
  ])('loads every $variant release pin from .env.testnet and records web prefix and epoch while preserving native storage keys', ({ variant, webBasePath }) => {
    const file = parseEnv(readFileSync(path.join(root, '.env.testnet'), 'utf8'))
    const config = variantConfig(root, variant)
    for (const [key, value] of Object.entries(file).filter(([key]) => key.startsWith('NEXT_PUBLIC_'))) {
      expect(config.env[key]).toBe(value)
    }
    expect(config.env.NEXT_PUBLIC_BASE_PATH).toBe('')
    expect(config.webBasePath).toBe(webBasePath)
    expect(config.storageEpoch).toBe(file.STORAGE_EPOCH)
    expect(config.networkKey).toMatch(/^[\w.-]+$/)
    expect(config.env.NEXT_PUBLIC_STORAGE_SCOPE).toBe('')
    expect(config.env.STORAGE_EPOCH).toBeUndefined()
  })

  it('keeps native storage of the staging app apart from the production app', () => {
    expect(variantConfig(root, 'staging-testnet').networkKey).not.toBe(variantConfig(root, 'testnet').networkKey)
  })

  it('fails closed on absent and unfilled production pins, even when the file disables release mode', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'native-release-'))
    try {
      expect(() => variantConfig(dir, 'testnet')).toThrow('Complete the public release configuration')
      writeFileSync(path.join(dir, '.env.testnet'), 'NEXT_PUBLIC_RELEASE=0\nNEXT_PUBLIC_NETWORK=testnet\n')
      expect(() => variantConfig(dir, 'testnet')).toThrow('defaults are forbidden')
      expect(() => variantConfig(dir, 'staging-testnet')).toThrow('defaults are forbidden')
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
