import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readEnvFile, REPO_ROOT } from './derive-identities.mjs'
import { insightUrl } from './sdk-env.mjs'

const devnetInsight = readEnvFile(join(REPO_ROOT, '.env.devnet')).NEXT_PUBLIC_INSIGHT_API_URL

describe('insightUrl', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('ignores the checked-in .env.devnet on testnet', () => {
    expect(devnetInsight).toBeTruthy()
    vi.stubEnv('NETWORK', 'testnet')
    vi.stubEnv('INSIGHT_URL', '')
    expect(insightUrl()).toBe('https://insight.testnet.networks.dash.org/insight-api')
  })

  it('takes an explicit INSIGHT_URL on testnet', () => {
    vi.stubEnv('NETWORK', 'testnet')
    vi.stubEnv('INSIGHT_URL', 'https://insight.example/insight-api/')
    expect(insightUrl()).toBe('https://insight.example/insight-api')
  })

  it('reads .env.devnet on devnet', () => {
    vi.stubEnv('NETWORK', 'devnet')
    vi.stubEnv('INSIGHT_URL', '')
    vi.stubEnv('NEXT_PUBLIC_INSIGHT_API_URL', '')
    expect(insightUrl()).toBe(devnetInsight.replace(/\/$/, ''))
  })
})
