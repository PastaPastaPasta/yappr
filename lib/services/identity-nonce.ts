/**
 * Identity contract nonces for writes this browser makes (QA D-01).
 *
 * Two writes by one identity to one contract that read the nonce before either
 * has executed sign the same one; Platform accepts both broadcasts, executes
 * one and drops the other without a result. So every write runs under
 * `withIdentityWriteLock`, and the last nonce this browser broadcast is kept
 * here as a reservation, because Platform's nonce only moves once a
 * transition executes (and a node may answer a block behind).
 *
 * `stateTransitionService.createDocument` picks its own nonce and allocates
 * past the reservation. Writes the SDK signs itself (document replace and
 * delete, token and moderation transitions) go through {@link withSdkSignedWrite}.
 */
import { Identifier } from '@dashevo/evo-sdk';
import { logger } from '@/lib/logger';
import { scopedKey } from '@/lib/storage-scope';
import { allocateIdentityContractNonce, nextIdentityContractNonce } from '@/lib/document-id';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { getEvoSdk } from './evo-sdk-service';

/** Kept in localStorage so every tab sees it; read and written only under the write lock. */
const RESERVATION_PREFIX = scopedKey('yappr:nonce-reserved:');

/** This tab's copy, for when localStorage is blocked. */
const reservedNonces = new Map<string, bigint>();

function reservationKey(ownerId: string, contractId: string): string {
  return `${RESERVATION_PREFIX}${ownerId}:${contractId}`;
}

/** The last nonce this browser broadcast for `ownerId` on `contractId`, or null. */
export function loadReservedNonce(ownerId: string, contractId: string): bigint | null {
  const key = reservationKey(ownerId, contractId);
  try {
    const raw = localStorage.getItem(key);
    if (raw) return BigInt(raw);
  } catch {
    // Storage blocked or the value unreadable: fall back to this tab's record.
  }
  return reservedNonces.get(key) ?? null;
}

/** Record `nonce` as broadcast, before the broadcast: one that errors may still have gone out. */
export function reserveNonce(ownerId: string, contractId: string, nonce: bigint): void {
  const key = reservationKey(ownerId, contractId);
  reservedNonces.set(key, nonce);
  try {
    localStorage.setItem(key, nonce.toString());
  } catch {
    // Storage blocked: only this tab knows, and the write lock still covers it.
  }
}

/**
 * Run a write the SDK signs itself under the identity's write lock, in step
 * with the nonces `createDocument` hands out.
 *
 * The SDK takes the next nonce from its own cache, which never sees a nonce
 * `createDocument` broadcast. So while a reservation is ahead of Platform this
 * waits (briefly) for it to execute, then has the SDK re-read the nonce, and
 * records the one the SDK will sign with so the next create skips it even if
 * the node it asks is a block behind. A reservation that never executes (its
 * transition was refused) stops being waited on after this one write.
 */
export async function withSdkSignedWrite<T>(ownerId: string, contractId: string, write: () => Promise<T>): Promise<T> {
  return withIdentityWriteLock(ownerId, contractId, async () => {
    const sdk = await getEvoSdk();
    const reserved = loadReservedNonce(ownerId, contractId);
    let current = await sdk.identities.contractNonce(ownerId, contractId);
    const reservationAhead = () => allocateIdentityContractNonce(current, reserved) > nextIdentityContractNonce(current);
    for (let attempt = 0; attempt < 5 && reservationAhead(); attempt++) {
      logger.debug(`Waiting for nonce ${reserved} to execute before an SDK-signed write (Platform at ${current})`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      current = await sdk.identities.contractNonce(ownerId, contractId);
    }
    try { await sdk.wasm.refreshIdentityNonce(new Identifier(ownerId)); } catch { /* best effort */ }
    reserveNonce(ownerId, contractId, nextIdentityContractNonce(current));
    return write();
  });
}
