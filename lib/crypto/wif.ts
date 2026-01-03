import bs58check from 'bs58check'

// Network WIF prefixes
export const TESTNET_WIF_PREFIX = 0xef // 239
export const MAINNET_WIF_PREFIX = 0xcc // 204

export interface DecodedWif {
  privateKey: Uint8Array
  compressed: boolean
  prefix: number
}

/**
 * Decode WIF (Wallet Import Format) to private key
 */
export function wifToPrivateKey(wif: string): DecodedWif {
  const decoded = bs58check.decode(wif)
  const prefix = decoded[0]

  if (decoded.length === 34 && decoded[33] === 0x01) {
    // Compressed key (most common)
    return {
      privateKey: decoded.slice(1, 33),
      compressed: true,
      prefix,
    }
  } else if (decoded.length === 33) {
    // Uncompressed key
    return {
      privateKey: decoded.slice(1, 33),
      compressed: false,
      prefix,
    }
  }

  throw new Error('Invalid WIF format')
}

/**
 * Validate WIF network prefix
 */
export function validateWifNetwork(
  prefix: number,
  network: 'testnet' | 'mainnet'
): boolean {
  const expectedPrefix = network === 'mainnet' ? MAINNET_WIF_PREFIX : TESTNET_WIF_PREFIX
  return prefix === expectedPrefix
}
