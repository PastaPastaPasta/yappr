export declare const NONCE_SEQUENCE_MASK: bigint
export declare const MAX_NONCE_DISTANCE: bigint
export declare function lastAcceptedNonce(current: bigint | number | undefined | null): bigint
export declare function identityContractNonceConsumed(current: bigint | number | undefined | null, nonce: bigint | string): boolean
