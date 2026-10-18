'use client'

import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { Post } from '@/lib/types'
import { privateFeedKeyStore } from '@/lib/services/private-feed-key-store'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'

export type QuoteDecryptionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'decrypted'; content: string }
  | { status: 'locked'; needsKey?: boolean }
  | { status: 'error' }

/** Open a quoted private post for `viewerId` with the encryption key this device holds. */
export async function decryptQuote(post: Post, viewerId: string): Promise<QuoteDecryptionState> {
  const { decryptPostOrReply } = await import('@/lib/services/private-feed-reader')
  const opened = await decryptPostOrReply(post, viewerId, getEncryptionKeyBytes(viewerId) ?? undefined)
  if (!opened) return { status: 'error' }
  const { outcome } = opened
  return outcome.ok ? { status: 'decrypted', content: outcome.text } : { status: 'locked', needsKey: outcome.reason === 'needs-key' }
}

/** A quote waiting on keys this device does not hold yet opens once they are recovered elsewhere (another post, another tab). */
export function useRetryWhenKeysArrive(state: QuoteDecryptionState, setState: Dispatch<SetStateAction<QuoteDecryptionState>>): void {
  const awaitingKeys = state.status === 'locked' && state.needsKey === true
  useEffect(() => {
    if (!awaitingKeys) return
    return privateFeedKeyStore.subscribe(() => setState({ status: 'idle' }))
  }, [awaitingKeys, setState])
}
