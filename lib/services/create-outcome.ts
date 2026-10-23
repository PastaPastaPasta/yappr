import type { CreateReceipt, StateTransitionResult } from './state-transition-service';

/**
 * What a create came to:
 *
 * - `confirmed`: Platform shows the document;
 * - `pending`: it was sent, but whether it landed is not proved yet. It may
 *   still land, so it must not be built again: its `receipt` (absent only for
 *   an indexOnly create or a replay of cached bytes) settles it later
 *   (`stateTransitionService.settleCreate`);
 * - `failed`: refused, never sent, or proved never recorded. It will not land.
 */
export type CreateOutcome<T> =
  | { status: 'confirmed'; document: T }
  | { status: 'pending'; document: T; receipt?: CreateReceipt }
  | { status: 'failed'; error: string };

/** The {@link CreateOutcome} of a `stateTransitionService.createDocument` result, its document read with `read`. */
export function createOutcomeOf<T>(result: StateTransitionResult, read: (document: Record<string, unknown>) => T): CreateOutcome<T> {
  // createDocument gives every success a document; one without is treated as before, as a failure.
  if (!result.success || !result.document) return { status: 'failed', error: result.error || 'Failed to create document' };
  const document = read(result.document);
  if (result.confirmed === false) return { status: 'pending', document, ...(result.receipt ? { receipt: result.receipt } : {}) };
  return { status: 'confirmed', document };
}
