import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('payment network labels', () => {
  it.each([
    ['devnet', 'Devnet'],
    ['testnet', 'Testnet'],
    ['mainnet', 'Testnet'],
  ])('labels tdash on %s as %s while keeping other currencies unchanged', async (network, label) => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', network)
    const { getPaymentLabel, PAYMENT_SCHEME_LABELS, TDASH_NETWORK_LABEL } = await import('@/components/ui/payment-icons')

    expect(TDASH_NETWORK_LABEL).toBe(label)
    expect(PAYMENT_SCHEME_LABELS['tdash:']).toBe(`Dash (${label})`)
    expect(getPaymentLabel('TDASH:yWUs17ht6ZcAw2EgZkEetnaLW9uX3aWfsw')).toBe(`Dash (${label})`)
    expect(getPaymentLabel('dash:XdZgS6gbprXuu2SpRgv2ygVL9FNqBrWAHJ')).toBe('Dash')
    expect(getPaymentLabel('bitcoin:bc1qexample')).toBe('Bitcoin')
  })
})
