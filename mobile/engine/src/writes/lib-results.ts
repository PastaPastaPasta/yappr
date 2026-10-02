import { extractErrorMessage } from '@/lib/error-utils'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import type { StateTransitionResult } from '@/lib/services/state-transition-service'
import { LIB_REFUSED_MESSAGE } from './classify'
import type { ProbeResult, WriteResult } from './tickets'
import type { TicketDocument } from './types'

/**
 * lib's write results mapped to ticket results (ENGINE.md §7.1), for the
 * write handlers M7b registers.
 */

/**
 * `StateTransitionResult`: success with `confirmed: false` is a broadcast
 * whose confirmation wait gave no verdict (the DAPI gateway timeout), so the
 * ticket is `unconfirmed`, never `confirmed`.
 */
export function fromTransitionResult(result: StateTransitionResult, documents?: TicketDocument[]): WriteResult {
  if (!result.success) return { state: 'failed', error: new Error(result.error ?? 'Unknown error'), documents }
  return { state: result.confirmed === false ? 'unconfirmed' : 'confirmed', documents }
}

/**
 * The services that answer `boolean` (`likePost`, `bookmarkPost`, ...):
 * `false` is `failed`, refused and retryable (`LIB_REFUSED_MESSAGE`). They
 * swallow the `confirmed: false` signal, as on web, so `true` is taken as
 * `confirmed`.
 */
export function fromBoolean(ok: boolean, documents?: TicketDocument[]): WriteResult {
  return ok
    ? { state: 'confirmed', documents }
    : { state: 'failed', error: new Error(LIB_REFUSED_MESSAGE), documents }
}

/**
 * A delete or tombstone service's boolean (`deleteOwnPost`, `deleteOwnReply`).
 * lib's `deleteDocument` and `tombstoneDocument` send and wait in one call
 * and answer `false` for any error, a gateway timeout included, so `false`
 * does not prove the change was refused. The write's own probe decides: the
 * document still there is `failed` and retryable (`fromBoolean`), proved gone
 * (or blanked) is `confirmed`, and an unreadable answer is `unconfirmed`, for
 * Check again.
 */
export async function fromDeleteBoolean(ok: boolean, probe: () => Promise<ProbeResult>): Promise<WriteResult> {
  if (ok) return fromBoolean(true)
  const proof = await probe()
  if (proof.state === 'applied') return { state: 'confirmed' }
  return proof.state === 'not-applied' ? fromBoolean(false) : { state: 'unconfirmed' }
}

/**
 * A document lib's `create()` returned: `__createConfirmed: false` marks a
 * broadcast whose confirmation wait gave no verdict (`publish-thread.ts`
 * `wasConfirmed`).
 */
export function wasConfirmed(document: unknown): boolean {
  return (document as { __createConfirmed?: boolean }).__createConfirmed !== false
}

/**
 * The document a successful `StateTransitionResult` created: its id is the
 * result's `transactionHash` (state-transition-service `createDocument`). A
 * service that found the document already there answers success without one.
 */
export function createdDocument(result: StateTransitionResult, contractId: string, type: string): TicketDocument[] {
  return result.success && result.transactionHash
    ? [{ contractId, type, id: result.transactionHash, action: 'create', confirmed: result.confirmed !== false }]
    : []
}

/**
 * Prove a document present or absent with one proved `documents.get`. A
 * "not found" answer is absence; any other failure throws, because it proves
 * nothing (the same rule as lib's `checkDocumentExists`).
 */
export async function documentExists(document: Pick<TicketDocument, 'contractId' | 'type' | 'id'>): Promise<boolean> {
  const sdk = await getEvoSdk()
  try {
    return Boolean(await sdk.documents.get(document.contractId, document.type, document.id))
  } catch (error) {
    const message = extractErrorMessage(error).toLowerCase()
    if (message.includes('not found') || message.includes('404') || message.includes('no document')) return false
    throw error
  }
}
