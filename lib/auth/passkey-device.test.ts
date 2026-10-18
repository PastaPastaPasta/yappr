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

    localStorage.setItem(`yappr_passkey_unsettled:${IDENTITY}`, JSON.stringify({ vault: 1 }))
    expect(device.unsettledPasskey(IDENTITY)).toBeNull()
  })
})

/**
 * Runs `other` (another tab's write) inside this tab's next write, after
 * anything this tab read and right before its own value lands: exactly where
 * a read-modify-write of a shared value would overwrite it.
 */
function racing(other: () => void): void {
  const setItem = localStorage.setItem.bind(localStorage)
  let raced = false
  localStorage.setItem = (key: string, value: string) => {
    if (!raced) {
      raced = true
      other()
    }
    setItem(key, value)
  }
}

describe('records kept per fact', () => {
  it('never lose another tab\'s write that lands in the middle of this one', async () => {
    const device = await load()
    racing(() => device.rememberPasskeyHere(IDENTITY, 'cred2.bb'))
    device.rememberPasskeyHere(IDENTITY, 'cred1.aa')
    racing(() => device.rememberUnsettledPasskey('identity-2', { ...UNSETTLED, credentialId: 'b3RoZXI' }))
    device.rememberUnsettledPasskey(IDENTITY, UNSETTLED)
    racing(() => device.setPasskeyName('cred2.bb', 'Phone'))
    device.setPasskeyName('cred1.aa', 'Laptop')
    racing(() => device.rememberPasskeyHere('identity-2', 'cred3.cc'))
    device.forgetPasskeyHere(IDENTITY, 'nothing-here')
    device.rememberPasskeyHere('identity-2', 'cred3.cc')

    const after = await load()
    expect(after.passkeysHere(IDENTITY).sort()).toEqual(['cred1.aa', 'cred2.bb'])
    expect(after.passkeysHere('identity-2')).toEqual(['cred3.cc'])
    expect(after.unsettledPasskey(IDENTITY)).toEqual(UNSETTLED)
    expect(after.unsettledPasskey('identity-2')?.credentialId).toBe('b3RoZXI')
    expect([after.passkeyName('cred1.aa'), after.passkeyName('cred2.bb')]).toEqual(['Laptop', 'Phone'])

    after.forgetPasskeyHere(IDENTITY, 'cred1')
    expect(after.passkeysHere(IDENTITY)).toEqual(['cred2.bb'])
    expect(after.passkeysHere('identity-2')).toEqual(['cred3.cc'])
    after.setPasskeyName('cred1.aa', '  ')
    expect(after.passkeyName('cred1.aa')).toBeNull()
  })
})
