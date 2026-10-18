import { expect, it } from 'vitest'
import { snapshotContractIds, snapshotEnvFiles } from './snapshot-contract-config.mjs'

it('collects both testnet deployments without ever loading the placeholder template', () => {
  expect(snapshotEnvFiles('testnet')).toEqual(['.env.testing', '.env.testnet'])
  expect(snapshotEnvFiles('devnet')).toEqual(['.env.devnet'])
  expect(snapshotEnvFiles('mainnet')).toEqual([])
})

it('pruning retains the union of requested deployment contracts and anchor, not tokens or retired blanks', () => {
  expect(snapshotContractIds([
    { NEXT_PUBLIC_YAPPR_CONTRACT_ID: 'testing', NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID: '' },
    { NEXT_PUBLIC_YAPPR_CONTRACT_ID: 'release', NEXT_PUBLIC_APP_CONNECT_APP_ID: 'anchor',
      NEXT_PUBLIC_YAPP_TOKEN_ID: 'token', NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v17' },
  ], 'release, extra', 'dashpay', ['v17'])).toEqual(['anchor', 'dashpay', 'extra', 'release', 'testing'])
})

it('isolates the staging snapshot and refuses other networks', () => {
  expect(snapshotEnvFiles('testnet', true)).toEqual(['.env.staging'])
  expect(() => snapshotEnvFiles('devnet', true)).toThrow('NETWORK=testnet')
  expect(snapshotEnvFiles('testnet')).toEqual(['.env.testing', '.env.testnet'])
})
