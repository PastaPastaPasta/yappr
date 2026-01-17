/**
 * Convert a hex string to a byte array (number[])
 * Platform requires byte arrays for indexed hash fields
 */
export function hexToBytes(hex: string): number[] {
  // Remove 0x prefix if present
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;

  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }

  const bytes: number[] = [];
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes.push(parseInt(cleanHex.substring(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Convert a byte array to a hex string
 */
export function bytesToHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hash160 produces a 20-byte hash (RIPEMD160(SHA256(data)))
 * Used for votingKeyHash and ownerKeyHash
 */
export function addressToHash160(address: string): string {
  // In a full implementation, this would decode the base58check address
  // and extract the 20-byte pubkey hash
  // For now, we just validate the format and return a placeholder
  // The actual implementation would use dashcore-lib

  if (address.length !== 34) {
    throw new Error(`Invalid address length: ${address.length}`);
  }

  // This is a placeholder - real implementation needs dashcore-lib
  // to properly decode the address
  return address;
}

/**
 * Validate a 64-character hex hash (SHA256 / 256-bit hash)
 */
export function isValidHash256(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

/**
 * Validate a 40-character hex hash (Hash160 / 160-bit hash)
 */
export function isValidHash160(hash: string): boolean {
  return /^[a-f0-9]{40}$/i.test(hash);
}

/**
 * Normalize a hash to lowercase
 */
export function normalizeHash(hash: string): string {
  return hash.toLowerCase();
}

/**
 * Truncate a hash for display (first 8 + last 8 characters)
 */
export function truncateHash(hash: string, chars: number = 8): string {
  if (hash.length <= chars * 2) {
    return hash;
  }
  return `${hash.slice(0, chars)}...${hash.slice(-chars)}`;
}
