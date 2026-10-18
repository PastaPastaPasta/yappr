import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubBrowserStorage } from '../test-storage'

const IDENTITY = 'identity-1'
const UNSETTLED = {
  vault: 'vault-contract',
  credentialId: 'Y3JlZA',
  recipientKey: 'ab'.repeat(32),
  receipts: [{ contractId: 'vault-contract', documentType: 'vaultEntry', ownerId: IDENTITY, documentId: 'doc-1', nonce: '18446744073709551615', transition: 'AQID' }],
}

/** A fresh module, as after a reload: only what the browser stored survives. */
async function load() {
  vi.resetModules()
  return import('./passkey-device')
}

beforeEach(() => {
  stubBrowserStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('unsettled passkeys', () => {
  it('outlive a reload, receipt included, until they settle', async () => {
    const before = await load()
    before.rememberUnsettledPasskey(IDENTITY, UNSETTLED)

    const after = await load()
    expect(after.unsettledPasskey(IDENTITY)).toEqual(UNSETTLED)
    // The recognition markers are separate: an unsettled passkey is not "this device's" yet.
    expect(after.passkeysHere(IDENTITY)).toEqual([])

    after.forgetUnsettledPasskey(IDENTITY, UNSETTLED.credentialId)
    expect((await load()).unsettledPasskey(IDENTITY)).toBeNull()
  })

  it('are forgotten only for their own credential', async () => {
    const device = await load()
    device.rememberUnsettledPasskey(IDENTITY, UNSETTLED)
    device.forgetUnsettledPasskey(IDENTITY, 'b3RoZXI')
    expect(device.unsettledPasskey(IDENTITY)).toEqual(UNSETTLED)
  })

  it('refuse a record with a malformed receipt, or a malformed record', async () => {
    const device = await load()
    // Dropping the receipt alone would let the rest look settled.
    device.rememberUnsettledPasskey(IDENTITY, { ...UNSETTLED, receipts: [{ ...UNSETTLED.receipts[0], nonce: '-1' }] })
    expect(device.unsettledPasskey(IDENTITY)).toBeNull()

    localStorage.setItem('yappr_passkey_unsettled', JSON.stringify({ [IDENTITY]: { vault: 1 } }))
    expect(device.unsettledPasskey(IDENTITY)).toBeNull()
  })
})
