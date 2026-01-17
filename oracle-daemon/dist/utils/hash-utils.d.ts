/**
 * Convert a hex string to a byte array (number[])
 * Platform requires byte arrays for indexed hash fields
 */
export declare function hexToBytes(hex: string): number[];
/**
 * Convert a byte array to a hex string
 */
export declare function bytesToHex(bytes: number[] | Uint8Array): string;
/**
 * Hash160 produces a 20-byte hash (RIPEMD160(SHA256(data)))
 * Used for votingKeyHash and ownerKeyHash
 */
export declare function addressToHash160(address: string): string;
/**
 * Validate a 64-character hex hash (SHA256 / 256-bit hash)
 */
export declare function isValidHash256(hash: string): boolean;
/**
 * Validate a 40-character hex hash (Hash160 / 160-bit hash)
 */
export declare function isValidHash160(hash: string): boolean;
/**
 * Normalize a hash to lowercase
 */
export declare function normalizeHash(hash: string): string;
/**
 * Truncate a hash for display (first 8 + last 8 characters)
 */
export declare function truncateHash(hash: string, chars?: number): string;
//# sourceMappingURL=hash-utils.d.ts.map