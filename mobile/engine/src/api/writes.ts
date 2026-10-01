import { getCurrentUserId } from '@/lib/services/sdk-helpers'
import { documentExists } from '../writes/lib-results'
import { createTicketStore, type TicketStore } from '../writes/tickets'
import type { WriteTicket } from '../writes/types'

export type * from '../writes/types'

/**
 * The engine's ticket store, wired to lib: tickets persist in engine kv, a
 * `check` proves documents with one proved read, and a write that fails for
 * want of a key asks the host for it.
 */
export function createEngineTicketStore(emit: (event: string, payload: unknown) => void): TicketStore {
  return createTicketStore({
    storage: localStorage,
    emit,
    currentIdentity: getCurrentUserId,
    onKeyRequired: identityId => emit('session.keyRequired', { identityId, purpose: 'auth' }),
    documentExists,
  })
}

/** `writes.*` (ENGINE.md §6.3, §7.2): the host's view of the ticket store. */
export function createWritesModule(store: TicketStore) {
  return {
    /** The active account's open tickets, and those confirmed in the last 10 minutes; newest first. */
    async list(): Promise<WriteTicket[]> {
      return store.list()
    },

    async get(ticketId: string): Promise<WriteTicket | null> {
      return store.get(ticketId)
    },

    /** "Check again" for an unconfirmed write. */
    check(ticketId: string): Promise<WriteTicket> {
      return store.check(ticketId)
    },

    /** Re-run a write that is proved not to have landed; otherwise rejects with NOT_RETRYABLE. */
    retry(ticketId: string): Promise<WriteTicket> {
      return store.retry(ticketId)
    },

    dismiss(ticketId: string): Promise<void> {
      return store.dismiss(ticketId)
    },
  }
}
