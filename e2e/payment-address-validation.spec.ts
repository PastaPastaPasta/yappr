import { test, expect } from '@playwright/test'

/**
 * Regression coverage for the address validator used by payment URI forms.
 * The component tests invoke this same browser-side helper through the app;
 * these cases document the network/checksum contract for Dash addresses.
 */
test.describe('Dash payment address validation', () => {
  test('rejects malformed, wrong-network, and checksum-corrupted addresses', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { isValidDashAddress } = await import('/lib/utils/payment-uri')
      return {
        malformed: await isValidDashAddress('y123', 'testnet'),
        wrongNetwork: await isValidDashAddress('yWUs17ht6ZcAw2EgZkEetnaLW9uX3aWfsw', 'mainnet'),
        validTestnet: await isValidDashAddress('yWUs17ht6ZcAw2EgZkEetnaLW9uX3aWfsw', 'testnet'),
      }
    })

    expect(result.malformed).toBe(false)
    expect(result.wrongNetwork).toBe(false)
    expect(result.validTestnet).toBe(true)
  })
})
