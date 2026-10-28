import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import {
  APP_KEY_PURPOSE,
  appEncryptionKeyPath,
  identityAuthKeyPath,
  InvalidPhraseError,
  legacyAppEncryptionKeyPath,
  normalizeRecoveryPhrase,
  openDip13Wallet,
  sessionAuthKeyPath,
} from './dip13'

/** BIP-39's all-zero-entropy phrase: the public test mnemonic every vector below is pinned to. */
const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const filled = (byte: number) => new Uint8Array(32).fill(byte)
const ascending = Uint8Array.from({ length: 32 }, (_, i) => i)
const descending = Uint8Array.from({ length: 32 }, (_, i) => 0xff - i)

describe('DIP-13 paths', () => {
  it('match the strings key-wallet builds (dip9.rs / bip32.rs tests)', () => {
    expect(identityAuthKeyPath('mainnet', 1, 2)).toBe("m/9'/5'/5'/0'/0'/1'/2'")
    expect(identityAuthKeyPath('testnet', 2, 3)).toBe("m/9'/1'/5'/0'/0'/2'/3'")
    // The DIP's 9-level path ends in the rotation, 0' by default.
    expect(appEncryptionKeyPath('mainnet', filled(1), filled(2))).toBe(`m/9'/5'/5'/7'/0'/0x${'01'.repeat(32)}'/0x${'02'.repeat(32)}'/1'/0'`)
    expect(appEncryptionKeyPath('testnet', filled(1), filled(2), APP_KEY_PURPOSE.DECRYPTION))
      .toBe(`m/9'/1'/5'/7'/0'/0x${'01'.repeat(32)}'/0x${'02'.repeat(32)}'/2'/0'`)
    expect(appEncryptionKeyPath('testnet', filled(1), filled(2), APP_KEY_PURPOSE.ENCRYPTION, 7))
      .toBe(`m/9'/1'/5'/7'/0'/0x${'01'.repeat(32)}'/0x${'02'.repeat(32)}'/1'/7'`)
    expect(appEncryptionKeyPath('testnet', filled(1), filled(2), APP_KEY_PURPOSE.ENCRYPTION, 0x7fffffff))
      .toMatch(/\/1'\/2147483647'$/)
    // The pre-DIP testnet path has no rotation level.
    expect(legacyAppEncryptionKeyPath('mainnet', filled(1), filled(2))).toBe(`m/9'/5'/5'/7'/0'/0x${'01'.repeat(32)}'/0x${'02'.repeat(32)}'/1'`)
    expect(legacyAppEncryptionKeyPath('testnet', filled(1), filled(2), APP_KEY_PURPOSE.DECRYPTION))
      .toBe(`m/9'/1'/5'/7'/0'/0x${'01'.repeat(32)}'/0x${'02'.repeat(32)}'/2'`)
    expect(sessionAuthKeyPath('testnet', ascending, descending))
      .toBe(`m/9'/1'/5'/6'/0'/0x${bytesToHex(ascending)}'/0x${bytesToHex(descending)}'`)
  })

  it('refuse ids that are not 32 bytes and indexes out of range', () => {
    expect(() => appEncryptionKeyPath('testnet', new Uint8Array(31), filled(2))).toThrow()
    expect(() => identityAuthKeyPath('testnet', -1, 0)).toThrow()
    expect(() => identityAuthKeyPath('testnet', 0x80000000, 0)).toThrow()
    expect(() => legacyAppEncryptionKeyPath('testnet', new Uint8Array(31), filled(2))).toThrow()
    for (const rotation of [-1, 0x80000000, 1.5, Number.NaN]) {
      expect(() => appEncryptionKeyPath('testnet', filled(1), filled(2), APP_KEY_PURPOSE.ENCRYPTION, rotation), `${rotation}`).toThrow()
    }
  })
})

describe('DIP-13 keys from a recovery phrase', () => {
  // rust-dashcore key-wallet `test_application_key_vectors`, dashpay/platform
  // `connect_keypairs_match_the_pinned_vectors` and swift-sdk
  // `ConnectKeyDerivationTests`: a change here orphans every registered key.
  it('reproduce the pinned application key vectors byte for byte', async () => {
    const wallet = await openDip13Wallet(TEST_PHRASE, 'mainnet')
    const pub = (path: string) => bytesToHex(wallet.derive(path).publicKey)
    expect(pub(sessionAuthKeyPath('testnet', filled(0x35), filled(0x6b))))
      .toBe('022c8b2e806244482374b1caf8306146dc03aad3b99a5954efd5e70a0eddd37a5d')
    expect(pub(legacyAppEncryptionKeyPath('mainnet', filled(0x35), filled(0x6b))))
      .toBe('03e989de1b62f137231cc06659c810c17100becd1f5e23d5710faa7602769fe434')
    expect(pub(sessionAuthKeyPath('testnet', ascending, descending)))
      .toBe('0278ad78c1a220924bf0e06e1111c61422efeace068f30efa825604b436970b230')
    expect(pub(legacyAppEncryptionKeyPath('mainnet', ascending, descending)))
      .toBe('03c4e462229f176595ec17e28e9096d3cfbc42496fb8ed4d48f8f58355d6105aa9')
    expect(pub(legacyAppEncryptionKeyPath('mainnet', ascending, descending, APP_KEY_PURPOSE.DECRYPTION)))
      .toBe('031fd0a3cfc01bebb89d43c2e12a6321c37ebdacb62c09495899e5b65a24fa5c99')
  })

  // DIP dashpay/dips#181 "Key Derivation Vectors": the rows with the rotation level.
  it('reproduce the DIP\'s 9-level encryption key vectors', async () => {
    const wallet = await openDip13Wallet(TEST_PHRASE, 'mainnet')
    const pub = (path: string) => bytesToHex(wallet.derive(path).publicKey)
    const { ENCRYPTION, DECRYPTION } = APP_KEY_PURPOSE
    expect(pub(appEncryptionKeyPath('mainnet', filled(0x35), filled(0x6b), ENCRYPTION, 0)))
      .toBe('031a882c119e2b1f8e0349b444d877afa2599efeef49a26930fd25518cb6e9d57a')
    expect(pub(appEncryptionKeyPath('mainnet', filled(0x35), filled(0x6b), ENCRYPTION, 1)))
      .toBe('03d0f6f0f48d968b9554d8e7fe467d7135bacf29d5c4994ca593bd10ebeed696f6')
    expect(pub(appEncryptionKeyPath('mainnet', ascending, descending, ENCRYPTION, 0)))
      .toBe('02dfed57ddaaea8c0758e8da44513520038eb8d6b0b92109953c14d6ab1087259b')
    expect(pub(appEncryptionKeyPath('mainnet', ascending, descending, DECRYPTION, 0)))
      .toBe('020bcde800f41ad1f924477a9502f111445224cc9ab70114ae4e5099ba02bdd034')
    expect(pub(appEncryptionKeyPath('mainnet', ascending, descending, DECRYPTION, 1)))
      .toBe('021b97869c21933673076a938337c28848c8bf8094bbe6883e3a4acbf33c639072')
    // The default rotation is 0'.
    expect(pub(appEncryptionKeyPath('mainnet', filled(0x35), filled(0x6b))))
      .toBe('031a882c119e2b1f8e0349b444d877afa2599efeef49a26930fd25518cb6e9d57a')
  })

  it('return a private key whose point is the public key', async () => {
    const key = (await openDip13Wallet(TEST_PHRASE, 'testnet')).derive(appEncryptionKeyPath('testnet', ascending, descending))
    expect(bytesToHex(getPublicKey(key.privateKey))).toBe(bytesToHex(key.publicKey))
  })

  it('derive identity auth keys as an independent BIP-32 does', async () => {
    const wallet = await openDip13Wallet(TEST_PHRASE, 'testnet')
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_PHRASE))
    for (const [identityIndex, keyIndex] of [[0, 0], [0, 2], [3, 1]]) {
      const path = identityAuthKeyPath('testnet', identityIndex, keyIndex)
      const reference = master.derive(path)
      const key = wallet.derive(path)
      expect(reference.publicKey && bytesToHex(reference.publicKey)).toBe(bytesToHex(key.publicKey))
      expect(reference.privateKey && bytesToHex(reference.privateKey)).toBe(bytesToHex(key.privateKey))
    }
    // And the well-known first identity's MASTER key on testnet stays put.
    expect(bytesToHex(wallet.derive(identityAuthKeyPath('testnet', 0, 0)).publicKey))
      .toBe('03a00f4853081aeb8c9debe37267303fa133bd7f6678bfb3299dfa001bfd0341db')
  })

  it('refuse a phrase whose checksum fails', async () => {
    const broken = TEST_PHRASE.replace(/about$/, 'abandon')
    await expect(openDip13Wallet(broken, 'testnet')).rejects.toBeInstanceOf(InvalidPhraseError)
  })
})

describe('opening a phrase', () => {
  it('reads a mixed-case, oddly spaced phrase as the wallet does (the step-up sheet passes it as typed)', async () => {
    const typed = `  ${TEST_PHRASE.toUpperCase().split(' ').join('\t ')}\n`
    const path = appEncryptionKeyPath('testnet', ascending, descending)
    const fromTyped = bytesToHex((await openDip13Wallet(typed, 'testnet')).derive(path).publicKey)
    expect(fromTyped).toBe(bytesToHex((await openDip13Wallet(TEST_PHRASE, 'testnet')).derive(path).publicKey))
  })
})

describe('normalizeRecoveryPhrase', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(normalizeRecoveryPhrase('  Abandon\tABANDON\n about  ')).toBe('abandon abandon about')
    expect(normalizeRecoveryPhrase('   ')).toBe('')
  })
})
