import bs58 from 'bs58';

export function decodeBase58(value: string): Uint8Array {
  try {
    return bs58.decode(value);
  } catch (error) {
    throw new Error(`Invalid base58 value: ${(error as Error).message}`);
  }
}

export function encodeBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}
