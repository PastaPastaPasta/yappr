import { beforeAll, expect, it, vi } from 'vitest'
import { EvoSDK, Identity, IdentitySigner, ensureInitialized } from '@dashevo/evo-sdk'
import { sentWriteOutcomeUnknown } from '@/lib/error-utils'
import { loadReservation, withSdkSignedWrite } from './identity-nonce'

const nonceSdk = vi.hoisted(() => ({
  identities: { contractNonce: vi.fn(async () => 100n) },
  wasm: { refreshIdentityNonce: vi.fn(async () => undefined) },
}))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => nonceSdk }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
})

beforeAll(async () => {
  await ensureInitialized()
})

it('releases the reservation after the real WASM parser rejects a function, allowing the next write immediately', async () => {
  const sdk = EvoSDK.testnetTrusted()
  const identity = new Identity(new Uint8Array(32).fill(1))
  const signer = new IdentitySigner()
  const owner = identity.id.toBase58()
  const contract = new Identity(new Uint8Array(32).fill(2)).id.toBase58()
  const options = { identity, signer, contractId: contract, identityId: owner, reason: { text: 'test' }, assertLive: () => undefined }
  try {
    const failure = await withSdkSignedWrite(owner, contract, () => sdk.contracts.warnUser(options)).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: 'InvalidArgument', message: expect.stringContaining('JsValue(Function') })
    expect(sentWriteOutcomeUnknown(failure)).toBe(false)
    expect(loadReservation(owner, contract)).toMatchObject({ floor: 100n, pending: [] })

    const nextWrite = vi.fn(async () => 'sent')
    await expect(withSdkSignedWrite(owner, contract, nextWrite)).resolves.toBe('sent')
    expect(nextWrite).toHaveBeenCalledOnce()
  } finally {
    identity.free()
    signer.free()
  }
})
