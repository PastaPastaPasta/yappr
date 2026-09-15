import { describe, expect, it } from 'vitest'
import { hexToBytes } from '@/lib/bytes'
import { decryptFromBinary } from '@/lib/message-encryption'
import { decryptBundle, unwrapDekWithPrf, type AuthVaultBundle } from './auth-vault'
import { privateFeedCryptoService } from '@/lib/services/private-feed-crypto-service'
import { wifToPrivateKey } from './wif'

/**
 * Ciphertext produced by the implementations that PRECEDED the shared
 * lib/crypto primitives (captured at 917018b4). These formats live on-chain
 * and in users' browsers, so the current code must keep reading them. If a
 * change here is deliberate, it is a data migration, not a refactor.
 */
const V = {
  aWif: 'cMcfH8sRgBgDMfpBNG6H3haaxLkaYXgqMRef8Nev6tWyBSNr6c3n',
  bWif: 'cVzZqtSJwsbHaTXXeMZFHQ7TiAqB26jWqKXP37tEdiUW7ArHtCsG',
  aPub: '0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0',
  bPub: '03ff5b19aa25aadc310aa0feb2178820d0df65873b4f4d4e5f1262cfd33f4582ae',
  dmCt: '48f63afe5c5af603dfa765c5823d7c4e6d29add083b883ad4f52b7a6c5835de6272d0b25dfce90315a2b136577',
  dek: '00254a6f94b9de03284d7297bce1062b50759abfe4092e53789dc2e70c31567b',
  prf: '0560bb1671cc2782dd3893ee49a4ff5ab5106bc6217cd7328de8439ef954af0a',
  bundleCt: 'edb5bcc1917013b63f1c6fd8e2c8bd8f8e80766d7dcb6120e1b38ed1c40ddd2555b9481eda18d777cca01a6cddad007addc1bc1edea2809f1db09ac027e4dae0c064f9a4a4413193febdc29d076f9fffe5ada72ecb3bd2759ff5ea27e6ec4b1189fbb351ecfaf022350f7da037fcc0c96acf8b025c6847690c003e3a1927feeb60b4668c197165c8a12afe502b7b5720fb78cbd388aeda4d26caa8b560ca7c0adfd8124e1e252dfe1106221764ec10f20aa7ab1bd20c88e6ffec658a7c33ad776a6bbae87f31826087bebf40206622e0326e1fb4b111c2',
  bundleIv: '62a724c5203a54af00aa4588',
  prfWrapped: 'de78bf7747a24ca2b7f0b961dc983e567a84f722e261e8bb1a08a676e4efff708eb45be386317803da3d382bef9ebce8',
  prfIv: '4d8d024dc8db105a81fe2065',
  eciesCt: '0267bde5358fdf5c1d50237536caa145953ea03a8b3dfa4accc73294e1a2e4b35e08063912b176b976f35a3ae41cc397d1ba998817ca8a36bb15e78449dc',
  eciesEphCt: '03c49c3632658e7af2534cf15b002c92b735769428d5a6aed125a7371db8308a3c0222e59ee33fd78f72d4d009c0bf96a92dcb5df341b3bc972073a642ff62a74e66',
  eph: '6465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80818283',
}

describe('persisted-format compatibility', () => {
  it('decrypts a direct message written by the previous module', async () => {
    expect(await decryptFromBinary(hexToBytes(V.dmCt), V.bWif, hexToBytes(V.aPub))).toBe('vector: hello bob')
  })

  it('decrypts an auth-vault bundle and unwraps a PRF-wrapped DEK from the previous module', async () => {
    const dek = hexToBytes(V.dek)
    const bundle = await decryptBundle(hexToBytes(V.bundleCt), hexToBytes(V.bundleIv), dek, 'vault-fixture', 'id-fixture', 'auth-key', 1)
    const expected: AuthVaultBundle = {
      version: 1,
      identityId: 'id-fixture',
      network: 'testnet',
      secretKind: 'auth-key',
      authKeyWif: V.aWif,
      source: 'direct-key',
      updatedAt: 1700000000000,
    }
    expect(bundle).toEqual(expected)
    expect(await unwrapDekWithPrf(hexToBytes(V.prfWrapped), hexToBytes(V.prfIv), hexToBytes(V.prf), 'id-fixture', 'vault-fixture', 'yap.pr')).toEqual(dek)
  })

  it('decrypts ECIES payloads from the previous module, as recipient and as re-deriving buyer', async () => {
    const aad = new TextEncoder().encode('yappr/test/v1')
    const aPriv = wifToPrivateKey(V.aWif).privateKey
    expect(new TextDecoder().decode(await privateFeedCryptoService.eciesDecrypt(aPriv, hexToBytes(V.eciesCt), aad))).toBe('vector: ecies')
    expect(
      new TextDecoder().decode(
        await privateFeedCryptoService.eciesDecryptWithEphemeralKey(hexToBytes(V.eph), hexToBytes(V.aPub), hexToBytes(V.eciesEphCt), aad)
      )
    ).toBe('vector: ecies-eph')
  })
})
