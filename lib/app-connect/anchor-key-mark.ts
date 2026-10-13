/**
 * The public key this browser last confirmed as an identity's current
 * anchor-bound encryption key (App Connect builds only).
 *
 * A raw-key session's stored encryption key counts only when it is that key
 * (`lib/secure-storage.ts`). Without the check, a key a legacy build left in
 * the same storage, or one a password vault restored unchecked, would be used
 * to read and send messages that peers can never match: on these builds they
 * encrypt to the anchor key. Such a key is not used; it stays in storage until
 * a confirmed key replaces it. The mark records a confirmation, not a live
 * check: an anchor key rotated later from elsewhere is not noticed here.
 *
 * Recorded by the checks that compare a key with the anchor's current one
 * (`lib/crypto/key-derivation.ts`, `lib/crypto/key-validation.ts`) and by
 * messaging setup once Platform shows the new key. Public data only, kept
 * free of the SDK like `memory-keys.ts`.
 */
import { bytesToHex } from '@/lib/bytes'
import { readScoped, writeScoped } from '@/lib/storage-scope'

const PREFIX = 'yappr_anchor_ek_'

export function rememberAnchorKey(identityId: string, publicKey: Uint8Array): void {
  writeScoped(PREFIX + identityId, bytesToHex(publicKey))
}

/** The confirmed anchor key as hex, or null when none was confirmed in this browser. */
export function rememberedAnchorKey(identityId: string): string | null {
  return readScoped(PREFIX + identityId)
}
