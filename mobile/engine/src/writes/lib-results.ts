import { extractErrorMessage } from '@/lib/error-utils'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import type { StateTransitionResult } from '@/lib/services/state-transition-service'
import type { WriteResult } from './tickets'
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
 * `false` is `failed`/UNKNOWN. They swallow the `confirmed: false` signal, as
 * on web, so `true` is taken as `confirmed`.
 */
export function fromBoolean(ok: boolean, documents?: TicketDocument[]): WriteResult {
  return ok
    ? { state: 'confirmed', documents }
    : { state: 'failed', error: new Error('The network did not accept this change'), documents }
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
