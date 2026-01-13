import { sha256 } from '@noble/hashes/sha2.js'
import bs58 from 'bs58'

// 5KB = 5000 bytes = 40,000 bits
const FILTER_SIZE_BYTES = 5000
const FILTER_SIZE_BITS = FILTER_SIZE_BYTES * 8 // 40,000 bits

// Optimal k (hash functions) for ~1000 items with ~0.1% false positive rate
// k = (m/n) * ln(2) where m = bits, n = expected items
// For n=1000, m=40000: k = (40000/1000) * 0.693 ≈ 28, but we use 10 for efficiency
const NUM_HASH_FUNCTIONS = 10

// Current version of bloom filter parameters (for forward compatibility)
export const BLOOM_FILTER_VERSION = 1

/**
 * Bloom filter implementation for efficient probabilistic set membership testing.
 * Used to quickly check if a user might be blocked before querying the platform.
 *
 * False positives are possible (says blocked when not), but false negatives are not
 * (if it says not blocked, they're definitely not blocked).
 */
export class BloomFilter {
  private bits: Uint8Array
  private _itemCount: number

  constructor(data?: Uint8Array, itemCount: number = 0) {
    if (data) {
      // Ensure we copy and pad/truncate to exact size
      this.bits = new Uint8Array(FILTER_SIZE_BYTES)
      this.bits.set(data.slice(0, FILTER_SIZE_BYTES))
    } else {
      this.bits = new Uint8Array(FILTER_SIZE_BYTES)
    }
    this._itemCount = itemCount
  }

  /**
   * Add an identifier to the bloom filter.
   * @param identifier - Base58 string or 32-byte Uint8Array
   */
  add(identifier: string | Uint8Array): void {
    const bytes = typeof identifier === 'string'
      ? bs58.decode(identifier)
      : identifier

    const positions = this.getHashPositions(bytes)
    for (const pos of positions) {
      const byteIndex = Math.floor(pos / 8)
      const bitIndex = pos % 8
      this.bits[byteIndex] |= (1 << bitIndex)
    }
    this._itemCount++
  }

  /**
   * Check if an identifier might be in the filter.
   * @param identifier - Base58 string or 32-byte Uint8Array
   * @returns true if the identifier might be in the set (possible false positive),
   *          false if definitely not in the set
   */
  mightContain(identifier: string | Uint8Array): boolean {
    const bytes = typeof identifier === 'string'
      ? bs58.decode(identifier)
      : identifier

    const positions = this.getHashPositions(bytes)
    for (const pos of positions) {
      const byteIndex = Math.floor(pos / 8)
      const bitIndex = pos % 8
      if (!(this.bits[byteIndex] & (1 << bitIndex))) {
        return false // Definitely not in the set
      }
    }
    return true // Might be in the set (could be false positive)
  }

  /**
   * Get bit positions for an identifier using multiple hash functions.
   * Uses SHA-256 and extracts multiple positions from the hash output.
   */
  private getHashPositions(data: Uint8Array): number[] {
    const positions: number[] = []
    let hash = sha256(data)

    for (let i = 0; i < NUM_HASH_FUNCTIONS; i++) {
      // Re-hash when we run out of bytes (every 8 positions)
      // SHA-256 produces 32 bytes, we use 4 bytes per position
      if (i > 0 && i % 8 === 0) {
        hash = sha256(hash)
      }

      const offset = (i % 8) * 4
      // Read 4 bytes as big-endian unsigned integer
      // Note: >>> 0 must be applied to the entire expression, not just the first shift,
      // because JavaScript's bitwise OR operates on signed 32-bit integers and can
      // produce negative results if the high bit is set.
      const value = (((hash[offset] << 24) |
                      (hash[offset + 1] << 16) |
                      (hash[offset + 2] << 8) |
                      hash[offset + 3]) >>> 0)

      // Modulo to get position within filter
      positions.push(value % FILTER_SIZE_BITS)
    }

    return positions
  }

  /**
   * Serialize the bloom filter to a Uint8Array for storage.
   */
  serialize(): Uint8Array {
    return new Uint8Array(this.bits)
  }

  /**
   * Get the number of items that have been added to the filter.
   */
  get itemCount(): number {
    return this._itemCount
  }

  /**
   * Estimate the current false positive rate based on items added.
   * Formula: (1 - e^(-k*n/m))^k
   * where k = hash functions, n = items, m = bits
   */
  estimateFalsePositiveRate(): number {
    const k = NUM_HASH_FUNCTIONS
    const m = FILTER_SIZE_BITS
    const n = this._itemCount
    if (n === 0) return 0
    return Math.pow(1 - Math.exp(-k * n / m), k)
  }

  /**
   * Merge another bloom filter into this one (OR operation).
   * Used to combine filters from multiple followed users.
   */
  merge(other: BloomFilter): void {
    for (let i = 0; i < FILTER_SIZE_BYTES; i++) {
      this.bits[i] |= other.bits[i]
    }
    // Item count becomes an estimate (sum of both)
    this._itemCount += other._itemCount
  }

  /**
   * Create a new bloom filter that is the union of multiple filters.
   */
  static merge(filters: BloomFilter[]): BloomFilter {
    const merged = new BloomFilter()
    for (const filter of filters) {
      merged.merge(filter)
    }
    return merged
  }

  /**
   * Check if the filter is empty (no bits set).
   */
  isEmpty(): boolean {
    return this.bits.every(byte => byte === 0)
  }

  /**
   * Get the size of the serialized filter in bytes.
   */
  static get sizeBytes(): number {
    return FILTER_SIZE_BYTES
  }
}

/**
 * Convert a Uint8Array to base64 string for sessionStorage.
 */
export function bloomFilterToBase64(filter: BloomFilter): string {
  const bytes = filter.serialize()
  // Use btoa with binary string conversion
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Create a BloomFilter from a base64 string.
 */
export function bloomFilterFromBase64(base64: string, itemCount: number = 0): BloomFilter {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new BloomFilter(bytes, itemCount)
}
