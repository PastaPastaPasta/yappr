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

/**
 * Check if a string looks like a WIF private key
 * Used to auto-detect whether user entered a password or private key
 */
export function isLikelyWif(input: string): boolean {
  // Quick format check - WIF is 51-52 chars
  if (input.length < 50 || input.length > 53) return false

  // Testnet WIF starts with 'c' or '9', mainnet with 'X' or '7'
  if (!/^[cC9X7]/.test(input)) return false

  // Try to decode - if valid WIF with checksum, it's a private key
  try {
    wifToPrivateKey(input)
    return true
  } catch {
    return false
  }
}

/**
 * Encode private key bytes to WIF (Wallet Import Format)
 */
export function privateKeyToWif(
  privateKey: Uint8Array,
  network: 'testnet' | 'mainnet' = 'testnet',
  compressed: boolean = true
): string {
  if (privateKey.length !== 32) {
    throw new Error('Private key must be 32 bytes')
  }

  const prefix = network === 'mainnet' ? MAINNET_WIF_PREFIX : TESTNET_WIF_PREFIX

  // Build the payload: prefix + private key + (compression flag if compressed)
  const payloadLength = compressed ? 34 : 33
  const payload = new Uint8Array(payloadLength)
  payload[0] = prefix
  payload.set(privateKey, 1)
  if (compressed) {
    payload[33] = 0x01
  }

  return bs58check.encode(payload)
}

/**
 * Check if input looks like a hex private key (64 chars, optional 0x prefix)
 */
export function isLikelyHex(input: string): boolean {
  let hex = input.trim()

  // Strip 0x prefix if present
  if (hex.startsWith('0x') || hex.startsWith('0X')) {
    hex = hex.slice(2)
  }

  // Must be exactly 64 hex characters (32 bytes)
  return hex.length === 64 && /^[0-9a-fA-F]+$/.test(hex)
}

/**
 * Parse hex string to Uint8Array.
 * Validates input before conversion to prevent silent corruption.
 */
export function hexToBytes(hex: string): Uint8Array {
  let cleanHex = hex.trim()
  if (cleanHex.startsWith('0x') || cleanHex.startsWith('0X')) {
    cleanHex = cleanHex.slice(2)
  }

  // Validate hex string
  if (cleanHex.length === 0) {
    throw new Error('Empty hex string')
  }
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Hex string must have even length')
  }
  if (!/^[0-9a-fA-F]+$/.test(cleanHex)) {
    throw new Error('Invalid hex characters')
  }

  const bytes = new Uint8Array(cleanHex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16)
  }
  return bytes
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface ParsedPrivateKey {
  privateKey: Uint8Array
  format: 'wif' | 'hex'
  network?: 'testnet' | 'mainnet'
}

/**
 * Parse any supported format (WIF or hex) to Uint8Array
 * Returns the private key bytes along with detected format info
 */
export function parsePrivateKey(input: string): ParsedPrivateKey {
  const trimmed = input.trim()

  // Try WIF first (more specific format)
  if (isLikelyWif(trimmed)) {
    const decoded = wifToPrivateKey(trimmed)
    const network = decoded.prefix === MAINNET_WIF_PREFIX ? 'mainnet' : 'testnet'
    return {
      privateKey: decoded.privateKey,
      format: 'wif',
      network,
    }
  }

  // Try hex format
  if (isLikelyHex(trimmed)) {
    const privateKey = hexToBytes(trimmed)
    return {
      privateKey,
      format: 'hex',
    }
  }

  throw new Error('Invalid private key format. Expected WIF (51-52 chars starting with c/9/X/7) or hex (64 hex characters)')
}
