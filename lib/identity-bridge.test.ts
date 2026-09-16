import { afterEach, expect, test, vi } from 'vitest'
import { identityBridgeUrl } from './identity-bridge'

afterEach(() => vi.unstubAllEnvs())

test.each(['testnet', 'mainnet'] as const)('identity creation retains %s', (network) => {
  vi.stubEnv('NEXT_PUBLIC_NETWORK', network)
  expect(new URL(identityBridgeUrl()).searchParams.get('network')).toBe(network)
})

test('Moutai uses the bridge devnet registry name', () => {
  expect(new URL(identityBridgeUrl('devnet', 'moutai')).searchParams.get('network')).toBe('devnet-moutai')
})

test('unset network retains the app testnet default', () => {
  vi.stubEnv('NEXT_PUBLIC_NETWORK', undefined)
  expect(new URL(identityBridgeUrl()).searchParams.get('network')).toBe('testnet')
})
