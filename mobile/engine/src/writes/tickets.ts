import { RpcError } from '../protocol/envelope'
import { readJson } from '../read-json'
import { classify, ticketStateFor } from './classify'
import type {
  EngineErrorData,
  TicketDocument,
  WriteOp,
  WriteStage,
  WriteTarget,
  WriteTicket,
} from './types'

/**
 * The write-ticket store (ENGINE.md §7): every write the engine runs gets a
 * ticket, `pending` until lib answers, then `confirmed`, `unconfirmed` (it may
 * have landed: check again) or `failed`. Tickets persist in engine kv, so they
 * survive engine restarts; a ticket still `pending` at load was interrupted,
 * and becomes `unconfirmed`. Nothing is ever re-sent on its own.
 */

/** Engine kv key (write-through to the host's MMKV). */
export const WRITES_STORAGE_KEY = 'yappr_engine_writes'
const MAX_TICKETS = 100
const CONFIRMED_TTL_MS = 24 * 60 * 60 * 1000
/** `list()` keeps showing a confirmed ticket this long. */
const CONFIRMED_LISTED_MS = 10 * 60 * 1000

/** What a write's lib call came to. Thrown errors are classified instead. */
export type WriteResult =
  | { state: 'confirmed' | 'unconfirmed'; documents?: TicketDocument[] }
  | { state: 'failed'; error: unknown; documents?: TicketDocument[] }

/** Whether an unconfirmed write took effect: proved either way, or not provable now. */
export type ProbeResult = { state: 'applied' } | { state: 'not-applied' } | { state: 'unknown'; error: unknown }

export interface WriteRunContext {
  /** The ticket as it stands (on a retry: its documents name what already landed). */
  readonly ticket: WriteTicket
  stage(stage: WriteStage): void
  progress(done: number, total: number): void
  /** Record document ids as soon as they are known, so a later `check` can prove them. */
  documents(documents: TicketDocument[]): void
}

/** How one kind of write runs, and how its outcome is proved. M7b registers one per `WriteOp`. */
export interface WriteHandler<A = unknown> {
  run(args: A, ctx: WriteRunContext): Promise<WriteResult>
  /** Default: prove each unconfirmed document in `ticket.documents` (see `createTicketStore`'s `probeDocument`). */
  probe?(ticket: WriteTicket, args: A | undefined): Promise<ProbeResult>
  /**
   * Whether the arguments may be persisted with the ticket (default true), so
   * a retry still works after an engine restart. False for anything that must
   * never reach disk, such as DM plaintext.
   */
  persistArgs?: boolean
}

export interface WriteRequest<A> {
  op: WriteOp
  args: A
  target?: WriteTarget | null
  documents?: TicketDocument[]
}

interface TicketRecord {
  ticket: WriteTicket
  /** Absent when the handler forbids persisting them and the engine restarted since. */
  args?: unknown
}

/** The persisted form: dates as epoch ms. */
interface StoredTicket extends Omit<WriteTicket, 'createdAt' | 'updatedAt' | 'lastCheckedAt'> {
  createdAt: number
  updatedAt: number
  lastCheckedAt: number | null
}

interface StoredRecord {
  ticket: StoredTicket
  args?: unknown
}

export interface TicketStoreOptions {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  emit(event: 'write.status', ticket: WriteTicket): void
  /** The signed-in identity: new tickets are stamped with it and `list()` shows only its tickets. */
  currentIdentity(): string | null
  /** Called when a write fails for want of a key (`NO_KEY`), so the host can prompt for it. */
  onKeyRequired?(identityId: string | null): void
  /** Proves one document present (`true`) or absent (`false`); throws when it cannot tell. */
  documentExists(document: TicketDocument): Promise<boolean>
  now?(): number
  newId?(): string
  /** Gap before a second read confirms a document's absence (default 2 s, as `waitForDocument`). */
  absenceRecheckMs?: number
}

export const RESTARTED_ERROR: EngineErrorData = {
  code: 'ENGINE_RESTARTED',
  consensusCode: null,
  outcome: 'unknown',
  retryable: false,
  userMessage: 'The app closed before this was confirmed. Check again to see whether it went through.',
}

const NOT_FOUND_ERROR: EngineErrorData = {
  code: 'NOT_RECORDED',
  consensusCode: null,
  outcome: 'not-recorded',
  retryable: true,
  userMessage: 'This was not found on the network. Try again.',
}

export type TicketStore = ReturnType<typeof createTicketStore>

export function createTicketStore(options: TicketStoreOptions) {
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())
  const handlers = new Map<WriteOp, WriteHandler>()
  const records = new Map<string, TicketRecord>()
  const absenceRecheckMs = options.absenceRecheckMs ?? 2_000

  const clone = (ticket: WriteTicket): WriteTicket => structuredClone(ticket)
  const allConfirmed = (documents: TicketDocument[]) => documents.map(doc => ({ ...doc, confirmed: true }))

  function persist() {
    const cutoff = now() - CONFIRMED_TTL_MS
    for (const [id, { ticket }] of records) {
      if (ticket.state === 'confirmed' && ticket.updatedAt.getTime() < cutoff) records.delete(id)
    }
    // Over the cap, drop settled tickets: confirmed, then failed, then unconfirmed
    // (those still need a check), oldest first. A pending one is never dropped.
    const dropOrder = { confirmed: 0, failed: 1, unconfirmed: 2 } as const
    const settled = [...records.values()].filter(r => r.ticket.state !== 'pending')
      .sort((a, b) => dropOrder[a.ticket.state as keyof typeof dropOrder] - dropOrder[b.ticket.state as keyof typeof dropOrder] ||
        a.ticket.updatedAt.getTime() - b.ticket.updatedAt.getTime())
    for (const { ticket } of settled) {
      if (records.size <= MAX_TICKETS) break
      records.delete(ticket.id)
    }
    const stored: StoredRecord[] = [...records.values()].map(({ ticket, args }) => ({
      ticket: {
        ...ticket,
        createdAt: ticket.createdAt.getTime(),
        updatedAt: ticket.updatedAt.getTime(),
        lastCheckedAt: ticket.lastCheckedAt?.getTime() ?? null,
      },
      ...(args !== undefined && handlers.get(ticket.op)?.persistArgs !== false ? { args } : {}),
    }))
    options.storage.setItem(WRITES_STORAGE_KEY, JSON.stringify(stored))
  }

  /** Tickets a restart left pending, reported once the API exists. */
  const reconciled: string[] = []

  function load() {
    const stored = readJson<unknown>(options.storage, WRITES_STORAGE_KEY, [])
    const valid = (Array.isArray(stored) ? stored : []).filter((r): r is StoredRecord => typeof r?.ticket?.id === 'string')
    for (const { ticket, args } of valid) {
      const restored: WriteTicket = {
        ...ticket,
        createdAt: new Date(ticket.createdAt),
        updatedAt: new Date(ticket.updatedAt),
        lastCheckedAt: ticket.lastCheckedAt === null ? null : new Date(ticket.lastCheckedAt),
      }
      // Interrupted by a crash or restart: whether it went out is unknown, and it is never re-sent.
      if (restored.state === 'pending') {
        Object.assign(restored, { state: 'unconfirmed', stage: null, error: RESTARTED_ERROR, retryable: false, updatedAt: new Date(now()) } satisfies Partial<WriteTicket>)
        reconciled.push(restored.id)
      }
      // Without its arguments (never persisted) a write cannot be re-run.
      if (args === undefined) restored.retryable = false
      records.set(restored.id, { ticket: restored, args })
    }
  }

  /** Persist the record's ticket and report it. */
  function commit(record: TicketRecord): WriteTicket {
    persist()
    const ticket = clone(record.ticket)
    options.emit('write.status', ticket)
    return ticket
  }

  function update(id: string, patch: Partial<WriteTicket>): WriteTicket {
    const record = recordOf(id)
    record.ticket = { ...record.ticket, ...patch, updatedAt: new Date(now()) }
    return commit(record)
  }

  function recordOf(id: string): TicketRecord {
    const record = records.get(id)
    if (!record) throw new RpcError(`Unknown write ticket ${id}`, 'BAD_REQUEST')
    return record
  }

  /** A ticket the host may act on: the active account's own (a retry would sign with the active account's key). */
  function ownRecord(id: string): TicketRecord {
    const record = recordOf(id)
    if (record.ticket.identityId !== options.currentIdentity()) {
      throw new RpcError('This write belongs to another account', 'BAD_REQUEST')
    }
    return record
  }

  /** The ticket's documents with `next` merged in (by action and id). */
  function withDocuments(id: string, next: TicketDocument[] | undefined): TicketDocument[] {
    const current = recordOf(id).ticket.documents
    if (!next) return current
    const merged = new Map(current.map(doc => [`${doc.action}:${doc.id}`, doc]))
    for (const doc of next) merged.set(`${doc.action}:${doc.id}`, doc)
    return [...merged.values()]
  }

  function fail(id: string, error: unknown, documents?: TicketDocument[]): void {
    const classified = classify(error)
    // A transport failure once the transition left the device says nothing about whether it landed.
    const sent = ['broadcasting', 'confirming'].includes(recordOf(id).ticket.stage ?? '')
    const data: EngineErrorData = sent && (classified.code === 'NETWORK' || classified.code === 'RATE_LIMITED')
      ? { ...classified, outcome: 'unknown', retryable: false }
      : classified
    const state = ticketStateFor(data)
    const ticket = update(id, {
      state,
      stage: null,
      error: data,
      retryable: state === 'failed' && data.retryable,
      documents: withDocuments(id, documents),
    })
    if (data.code === 'NO_KEY') options.onKeyRequired?.(ticket.identityId)
  }

  /** Run (or re-run) a ticket's write in the background. Never throws. */
  function start(id: string, handler: WriteHandler, args: unknown): void {
    const ctx: WriteRunContext = {
      get ticket() { return clone(recordOf(id).ticket) },
      stage: stage => { update(id, { stage }) },
      progress: (done, total) => { update(id, { progress: { done, total } }) },
      documents: documents => { update(id, { documents: withDocuments(id, documents) }) },
    }
    Promise.resolve()
      .then(() => handler.run(args, ctx))
      .then(result => {
        if (result.state === 'failed') {
          fail(id, result.error, result.documents)
          return
        }
        const documents = withDocuments(id, result.documents)
        update(id, {
          state: result.state,
          stage: null,
          error: null,
          retryable: false,
          documents: result.state === 'confirmed' ? allConfirmed(documents) : documents,
        })
      })
      .catch(error => fail(id, error))
      .catch(() => {
        // The ticket vanished (dismissed while settling): nothing left to report.
      })
  }

  async function probe(ticket: WriteTicket, args: unknown): Promise<ProbeResult> {
    const handler = handlers.get(ticket.op)
    try {
      if (handler?.probe) return await handler.probe(clone(ticket), args)
      if (ticket.documents.length === 0) {
        return { state: 'unknown', error: new Error('Nothing to check: this write named no documents') }
      }
      for (const doc of ticket.documents.filter(doc => !doc.confirmed)) {
        let exists = await options.documentExists(doc)
        // One node can lag: absence of a create counts only when a second read agrees.
        if (!exists && doc.action === 'create') {
          await new Promise(resolve => setTimeout(resolve, absenceRecheckMs))
          exists = await options.documentExists(doc)
        }
        if (exists !== (doc.action === 'create')) return { state: 'not-applied' }
      }
      return { state: 'applied' }
    } catch (error) {
      return { state: 'unknown', error }
    }
  }

  load()
  if (records.size > 0) persist()
  // After construction: the host's subscription (and the entry's dispatcher) exist by then.
  queueMicrotask(() => {
    for (const id of reconciled) {
      const record = records.get(id)
      if (record) options.emit('write.status', clone(record.ticket))
    }
  })

  return {
    /** Register how `op` runs; M7b's write methods each register one. */
    register<A>(op: WriteOp, handler: WriteHandler<A>): void {
      handlers.set(op, handler)
    },

    /**
     * Issue a ticket and start the write in the background. The returned
     * ticket is `pending`; every later transition is a `write.status` event.
     */
    submit<A>(request: WriteRequest<A>): WriteTicket {
      const handler = handlers.get(request.op)
      if (!handler) throw new RpcError(`No write handler for ${request.op}`, 'NOT_SUPPORTED')
      const at = new Date(now())
      const record: TicketRecord = {
        ticket: {
          id: newId(),
          op: request.op,
          identityId: options.currentIdentity(),
          state: 'pending',
          stage: 'queued',
          target: request.target ?? null,
          documents: request.documents ?? [],
          progress: null,
          error: null,
          retryable: false,
          createdAt: at,
          updatedAt: at,
          lastCheckedAt: null,
        },
        args: request.args,
      }
      records.set(record.ticket.id, record)
      const issued = commit(record)
      start(issued.id, handler, request.args)
      return issued
    },

    /** The active account's tickets: pending, unconfirmed and failed ones, and those confirmed in the last 10 minutes. */
    list(): WriteTicket[] {
      const identityId = options.currentIdentity()
      const recent = now() - CONFIRMED_LISTED_MS
      return [...records.values()]
        .map(record => record.ticket)
        .filter(ticket => ticket.identityId === identityId)
        .filter(ticket => ticket.state !== 'confirmed' || ticket.updatedAt.getTime() >= recent)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(clone)
    },

    get(id: string): WriteTicket | null {
      const record = records.get(id)
      return record && record.ticket.identityId === options.currentIdentity() ? clone(record.ticket) : null
    },

    /**
     * "Check again" (ENGINE.md §7.2) for an `unconfirmed` ticket: prove
     * whether it landed. Applied → `confirmed`; proved not applied → stays
     * `unconfirmed` and becomes retryable; unprovable → stays as is, with the
     * probe's error. Any other state is returned unchanged.
     */
    async check(id: string): Promise<WriteTicket> {
      const { ticket, args } = ownRecord(id)
      if (ticket.state !== 'unconfirmed') return clone(ticket)
      const result = await probe(ticket, args)
      const lastCheckedAt = new Date(now())
      // Dismissed, retried or checked again while the probe ran: its answer is stale.
      // (Every update replaces the ticket object, so identity tells whether it changed.)
      const current = records.get(id)?.ticket
      if (current !== ticket) return current ? clone(current) : { ...clone(ticket), lastCheckedAt }
      switch (result.state) {
        case 'applied':
          return update(id, { state: 'confirmed', error: null, retryable: false, lastCheckedAt, documents: allConfirmed(ticket.documents) })
        case 'not-applied':
          return update(id, { error: NOT_FOUND_ERROR, retryable: true, lastCheckedAt })
        case 'unknown':
          return update(id, { error: { ...classify(result.error), retryable: false }, retryable: false, lastCheckedAt })
      }
    },

    /**
     * Re-run a write with a fresh nonce, only where ENGINE.md §7.2 allows it:
     * a failed write that was refused retryably or never sent, or an
     * unconfirmed one a check proved absent. Otherwise `NOT_RETRYABLE`.
     */
    async retry(id: string): Promise<WriteTicket> {
      const { ticket, args } = ownRecord(id)
      const handler = handlers.get(ticket.op)
      if (ticket.state === 'pending' || !ticket.retryable) {
        throw new RpcError('This write cannot be retried now', 'NOT_RETRYABLE')
      }
      if (!handler || args === undefined) {
        throw new RpcError('This write can no longer be retried: start it again', 'NOT_RETRYABLE')
      }
      // The earlier attempt's unproven documents are gone (proved absent, or refused): a fresh
      // nonce gives fresh ids, which the new attempt records. Confirmed ones (thread parts) stay.
      const documents = ticket.documents.filter(doc => doc.confirmed)
      const restarted = update(id, { state: 'pending', stage: 'queued', error: null, retryable: false, documents })
      start(id, handler, args)
      return restarted
    },

    /** Forget a settled ticket. A pending one cannot be dismissed. */
    async dismiss(id: string): Promise<void> {
      if (!records.has(id)) return
      const record = ownRecord(id)
      if (record.ticket.state === 'pending') throw new RpcError('A pending write cannot be dismissed', 'BAD_REQUEST')
      records.delete(id)
      persist()
    },

    /** Drop every ticket of an identity (sign-out). */
    forgetIdentity(identityId: string): void {
      let changed = false
      for (const [id, record] of records) {
        if (record.ticket.identityId === identityId && record.ticket.state !== 'pending') {
          records.delete(id)
          changed = true
        }
      }
      if (changed) persist()
    },
  }
}
