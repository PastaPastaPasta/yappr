import assert from 'node:assert/strict'
import { isValidDashAddress, isValidPaymentAddress } from '../lib/utils/payment-uri.ts'

const validTestnet = 'yWUs17ht6ZcAw2EgZkEetnaLW9uX3aWfsw'
const validMainnet = 'XdZgS6gbprXuu2SpRgv2ygVL9FNqBrWAHJ'
assert.equal(isValidDashAddress('y123', 'testnet'), false)
assert.equal(isValidDashAddress(validTestnet.slice(0, -1) + 'x', 'testnet'), false)
assert.equal(isValidDashAddress(validTestnet, 'mainnet'), false)
assert.equal(isValidDashAddress(validTestnet, 'testnet'), true)
assert.equal(isValidDashAddress(validMainnet, 'mainnet'), true)
assert.equal(isValidPaymentAddress('tdash:', validTestnet), true)
assert.equal(isValidPaymentAddress('dash:', validTestnet), false)
assert.equal(isValidPaymentAddress('bitcoin:', 'bc1qexample'), true)
console.log('payment URI validation tests passed')
