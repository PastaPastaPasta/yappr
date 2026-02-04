/**
 * Key Exchange URI Module
 *
 * Generates `dash-key:` URIs for the Dash Platform Application Key Exchange Protocol.
 * These URIs are displayed as QR codes for users to scan with their wallet app.
 *
 * Supports v1 and v2 protocol formats.
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md
 */

import bs58 from 'bs58'

// Protocol versions
export const KEY_EXCHANGE_VERSION_1 = 1
export const KEY_EXCHANGE_VERSION_2 = 2

/** @deprecated Use KEY_EXCHANGE_VERSION_2 for new code */
export const KEY_EXCHANGE_VERSION = KEY_EXCHANGE_VERSION_1

// Network identifiers for URI query parameter
export const NETWORK_IDS = {
  mainnet: 'm',
  testnet: 't',
  devnet: 'd'
} as const

export type NetworkType = keyof typeof NETWORK_IDS

/**
 * Key exchange request data to be serialized and encoded in the URI
 */
export interface KeyExchangeRequest {
  /** Application's ephemeral public key for ECDH (33 bytes, compressed) */
  appEphemeralPubKey: Uint8Array
  /** Target application's contract ID (32 bytes) */
  contractId: Uint8Array
  /** Requested key derivation index (required for v1, absent in v2) */
  keyIndex?: number
  /** Optional display label for the wallet UI (max 64 chars) */
  label?: string
}

/**
 * Serialize a v1 key exchange request to bytes.
 *
 * v1 Field Layout:
 *   | Offset | Size | Field |
 *   |--------|------|-------|
 *   | 0 | 1 | version (0x01) |
 *   | 1 | 33 | appEphemeralPubKey |
 *   | 34 | 32 | contractId |
 *   | 66 | 4 | keyIndex (little-endian) |
 *   | 70 | 1 | labelLength |
 *   | 71 | 0-64 | label |
 *
 * Total size: 71 bytes (minimum) to 135 bytes (maximum)
 */
export function serializeRequest(request: KeyExchangeRequest): Uint8Array {
  // Validate inputs
  if (request.appEphemeralPubKey.length !== 33) {
    throw new Error(`Invalid ephemeral public key length: expected 33, got ${request.appEphemeralPubKey.length}`)
  }
  if (request.contractId.length !== 32) {
    throw new Error(`Invalid contract ID length: expected 32, got ${request.contractId.length}`)
  }

  const keyIndex = request.keyIndex ?? 0
  if (keyIndex < 0 || keyIndex > 0xFFFFFFFF) {
    throw new Error(`Invalid key index: must be 0-4294967295, got ${keyIndex}`)
  }

  // Encode label to UTF-8
  const encoder = new TextEncoder()
  const labelBytes = request.label ? encoder.encode(request.label) : new Uint8Array(0)

  if (labelBytes.length > 64) {
    throw new Error(`Label too long: max 64 bytes, got ${labelBytes.length}`)
  }

  // Calculate total size and allocate buffer
  const totalSize = 1 + 33 + 32 + 4 + 1 + labelBytes.length
  const buffer = new Uint8Array(totalSize)

  let offset = 0

  // Version (1 byte)
  buffer[offset++] = KEY_EXCHANGE_VERSION_1

  // App ephemeral public key (33 bytes)
  buffer.set(request.appEphemeralPubKey, offset)
  offset += 33

  // Contract ID (32 bytes)
  buffer.set(request.contractId, offset)
  offset += 32

  // Key index (4 bytes, little-endian)
  buffer[offset++] = keyIndex & 0xFF
  buffer[offset++] = (keyIndex >> 8) & 0xFF
  buffer[offset++] = (keyIndex >> 16) & 0xFF
  buffer[offset++] = (keyIndex >> 24) & 0xFF

  // Label length (1 byte)
  buffer[offset++] = labelBytes.length

  // Label (0-64 bytes)
  if (labelBytes.length > 0) {
    buffer.set(labelBytes, offset)
  }

  return buffer
}

/**
 * Serialize a v2 key exchange request to bytes.
 *
 * v2 Field Layout (no keyIndex - wallet manages it):
 *   | Offset | Size | Field |
 *   |--------|------|-------|
 *   | 0 | 1 | version (0x02) |
 *   | 1 | 33 | appEphemeralPubKey |
 *   | 34 | 32 | contractId |
 *   | 66 | 1 | labelLength |
 *   | 67 | 0-64 | label |
 *
 * Total size: 67 bytes (minimum) to 131 bytes (maximum)
 */
export function serializeRequestV2(request: KeyExchangeRequest): Uint8Array {
  // Validate inputs
  if (request.appEphemeralPubKey.length !== 33) {
    throw new Error(`Invalid ephemeral public key length: expected 33, got ${request.appEphemeralPubKey.length}`)
  }
  if (request.contractId.length !== 32) {
    throw new Error(`Invalid contract ID length: expected 32, got ${request.contractId.length}`)
  }

  // Encode label to UTF-8
  const encoder = new TextEncoder()
  const labelBytes = request.label ? encoder.encode(request.label) : new Uint8Array(0)

  if (labelBytes.length > 64) {
    throw new Error(`Label too long: max 64 bytes, got ${labelBytes.length}`)
  }

  // Calculate total size and allocate buffer (no keyIndex field)
  const totalSize = 1 + 33 + 32 + 1 + labelBytes.length
  const buffer = new Uint8Array(totalSize)

  let offset = 0

  // Version (1 byte)
  buffer[offset++] = KEY_EXCHANGE_VERSION_2

  // App ephemeral public key (33 bytes)
  buffer.set(request.appEphemeralPubKey, offset)
  offset += 33

  // Contract ID (32 bytes)
  buffer.set(request.contractId, offset)
  offset += 32

  // Label length (1 byte) - immediately after contractId, no keyIndex
  buffer[offset++] = labelBytes.length

  // Label (0-64 bytes)
  if (labelBytes.length > 0) {
    buffer.set(labelBytes, offset)
  }

  return buffer
}

/**
 * Build a complete dash-key: URI for the key exchange request.
 *
 * URI Format: dash-key:<request-data>?n=<network>&v=<version>
 *
 * @param request - The key exchange request data
 * @param network - The network type (mainnet, testnet, devnet)
 * @param version - Protocol version (1 or 2, default 2)
 * @returns Complete dash-key: URI string
 */
export function buildKeyExchangeUri(
  request: KeyExchangeRequest,
  network: NetworkType = 'testnet',
  version: number = KEY_EXCHANGE_VERSION_2
): string {
  // Serialize based on version
  const requestBytes = version === KEY_EXCHANGE_VERSION_2
    ? serializeRequestV2(request)
    : serializeRequest(request)

  const requestData = bs58.encode(requestBytes)

  // Get network identifier
  const networkId = NETWORK_IDS[network]

  // Build URI with query parameters
  return `dash-key:${requestData}?n=${networkId}&v=${version}`
}

/**
 * Parse a dash-key: URI back to request data.
 * Supports both v1 and v2 formats.
 *
 * @param uri - The dash-key: URI to parse
 * @returns Parsed request and network, or null if invalid
 */
export function parseKeyExchangeUri(uri: string): {
  request: KeyExchangeRequest
  network: NetworkType
  version: number
} | null {
  try {
    // Check scheme
    if (!uri.startsWith('dash-key:')) {
      return null
    }

    // Split data and query
    const uriWithoutScheme = uri.slice(9) // Remove 'dash-key:'
    const queryStart = uriWithoutScheme.indexOf('?')
    if (queryStart === -1) {
      return null
    }

    const requestData = uriWithoutScheme.slice(0, queryStart)
    const queryString = uriWithoutScheme.slice(queryStart + 1)

    // Parse query parameters
    const params = new URLSearchParams(queryString)
    const networkId = params.get('n')
    const versionStr = params.get('v')

    if (!networkId || !versionStr) {
      return null
    }

    const version = parseInt(versionStr, 10)
    if (version !== KEY_EXCHANGE_VERSION_1 && version !== KEY_EXCHANGE_VERSION_2) {
      return null
    }

    // Map network ID back to network type
    let network: NetworkType
    switch (networkId) {
      case 'm': network = 'mainnet'; break
      case 't': network = 'testnet'; break
      case 'd': network = 'devnet'; break
      default: return null
    }

    // Decode Base58 data
    const requestBytes = bs58.decode(requestData)

    // Parse fields
    let offset = 0

    // Version byte from payload
    const byteVersion = requestBytes[offset++]
    if (byteVersion !== version) {
      return null
    }

    if (version === KEY_EXCHANGE_VERSION_2) {
      // v2 format: no keyIndex field
      // Minimum size: 1 (version) + 33 (pubkey) + 32 (contractId) + 1 (labelLen) = 67
      if (requestBytes.length < 67) {
        return null
      }

      // App ephemeral public key (33 bytes)
      const appEphemeralPubKey = requestBytes.slice(offset, offset + 33)
      offset += 33

      // Contract ID (32 bytes)
      const contractId = requestBytes.slice(offset, offset + 32)
      offset += 32

      // Label length (1 byte) - directly after contractId
      const labelLength = requestBytes[offset++]

      // Label
      let label: string | undefined
      if (labelLength > 0) {
        const decoder = new TextDecoder()
        label = decoder.decode(requestBytes.slice(offset, offset + labelLength))
      }

      return {
        request: {
          appEphemeralPubKey,
          contractId,
          // keyIndex is absent in v2
          label
        },
        network,
        version
      }
    } else {
      // v1 format: includes keyIndex
      // Minimum size: 1 (version) + 33 (pubkey) + 32 (contractId) + 4 (keyIndex) + 1 (labelLen) = 71
      if (requestBytes.length < 71) {
        return null
      }

      // App ephemeral public key (33 bytes)
      const appEphemeralPubKey = requestBytes.slice(offset, offset + 33)
      offset += 33

      // Contract ID (32 bytes)
      const contractId = requestBytes.slice(offset, offset + 32)
      offset += 32

      // Key index (4 bytes, little-endian)
      const keyIndex = (
        requestBytes[offset] |
        (requestBytes[offset + 1] << 8) |
        (requestBytes[offset + 2] << 16) |
        (requestBytes[offset + 3] << 24)
      ) >>> 0 // Convert to unsigned
      offset += 4

      // Label length
      const labelLength = requestBytes[offset++]

      // Label
      let label: string | undefined
      if (labelLength > 0) {
        const decoder = new TextDecoder()
        label = decoder.decode(requestBytes.slice(offset, offset + labelLength))
      }

      return {
        request: {
          appEphemeralPubKey,
          contractId,
          keyIndex,
          label
        },
        network,
        version
      }
    }
  } catch {
    return null
  }
}

/**
 * Decode an identity ID from Base58 to raw 32 bytes.
 *
 * @param identityIdBase58 - The Base58-encoded identity ID
 * @returns The raw 32-byte identifier
 */
export function decodeIdentityId(identityIdBase58: string): Uint8Array {
  const bytes = bs58.decode(identityIdBase58)
  if (bytes.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${bytes.length}`)
  }
  return bytes
}

/**
 * Decode a contract ID from Base58 to raw 32 bytes.
 *
 * @param contractIdBase58 - The Base58-encoded contract ID
 * @returns The raw 32-byte identifier
 */
export function decodeContractId(contractIdBase58: string): Uint8Array {
  const bytes = bs58.decode(contractIdBase58)
  if (bytes.length !== 32) {
    throw new Error(`Invalid contract ID length: expected 32, got ${bytes.length}`)
  }
  return bytes
}
