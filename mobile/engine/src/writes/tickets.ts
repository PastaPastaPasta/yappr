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
 * and becomes `unconfirmed`, or `failed` and retryable when its handler
 * proves that attempt sent nothing (`stagedSends`). A write whose lib call
 * goes a minute without a word (a DAPI stall: the fetch never settles) reads
 * `unconfirmed` (`STILL_SENDING`) while the call runs on; its answer still
 * settles the ticket. Nothing that may have landed is ever re-sent on its
 * own: only a refusal Platform gave for a passing reason (`AUTO_RETRY_CODES`)
 * is sent again, a few times, while the ticket stays `pending`.
 */

/** Engine kv key (write-through to the host's MMKV). */
export const WRITES_STORAGE_KEY = 'yappr_engine_writes'
const MAX_TICKETS = 100
const CONFIRMED_TTL_MS = 24 * 60 * 60 * 1000
/** `list()` keeps showing a confirmed ticket this long. */
const CONFIRMED_LISTED_MS = 10 * 60 * 1000
/**
 * How long a running write may go without a word (a stage, progress or a
 * document) before its ticket reads `unconfirmed` (PRD G-3: "Not confirmed
 * yet" after 60 s). Default for every handler (`WriteHandler.deadlineMs`).
 */
export const PENDING_DEADLINE_MS = 60_000

/**
 * Refusals that say nothing about the write itself, only about the moment
 * (PRD G-4, UX_SPEC §5.4): a parent too young to reference, a fee multiplier
 * that moved. Platform refused them, so they never executed and sending
 * again cannot duplicate anything. A moderators-share mismatch
 * (`FEE_SHARE_MISMATCH`) is not one: lib always agrees to the full declared
 * fee, so it means the client and the contract disagree, and each re-send
 * would only be refused (and charged) the same way. The ticket stays
 * `pending` and is sent again after each of `AUTO_RETRY_DELAYS_MS`; only the
 * last refusal is reported. A nonce refusal (`NONCE_CONFLICT`) is not one: it
 * may be this very transition executing, so it stays `unconfirmed` for a
 * check, and lib's pending-nonce refusal (`PENDING_WRITE`) is not either: it
 * holds for minutes, so re-sending would only loop.
 */
export const AUTO_RETRY_CODES: ReadonlySet<EngineErrorData['code']> = new Set(['PARENT_TOO_YOUNG', 'FEE_CHANGED'])
/** The backoff before each silent re-send: three at most. */
export const AUTO_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000]

/** What a write's lib call came to. Thrown errors are classified instead. */
export type WriteResult =
  | { state: 'confirmed' | 'unconfirmed'; documents?: TicketDocument[] }
  | { state: 'failed'; error: unknown; documents?: TicketDocument[] }

/**
 * Whether an unconfirmed write took effect: proved either way, or not
 * provable now. `documents` are ones the probe found that the ticket did not
 * name yet (a post found by its content); `check` records them.
 */
export type ProbeResult =
  | { state: 'applied'; documents?: TicketDocument[] }
  | { state: 'not-applied'; documents?: TicketDocument[] }
  | { state: 'unknown'; error: unknown; documents?: TicketDocument[] }

export interface WriteRunContext {
  /** The ticket as it stands (on a retry: its documents name what already landed). */
  readonly ticket: WriteTicket
  /**
   * The stage the attempt is in. From the first stage on, a restart no
   * longer proves the attempt sent nothing (`stagedSends`), unless
   * `beforeSend` says this stage comes before any write call
   * (`settleTarget`'s wait for a parent, which may last minutes).
   */
  stage(stage: WriteStage, beforeSend?: boolean): void
  progress(done: number, total: number): void
  /** Record document ids as soon as they are known, so a later `check` can prove them. */
  documents(documents: TicketDocument[]): void
  /** Run this write's own probe (what `check` runs) against the ticket as it stands. */
  probe(): Promise<ProbeResult>
}

/** What the store lends a handler's own probe, so every probe proves documents the same way. */
export interface ProbeKit {
  /** The default proof: each unconfirmed document present (create) or absent (delete); a disagreement counts only when a second read agrees. */
  proveDocuments(documents: TicketDocument[]): Promise<ProbeResult>
  /** The gap before a second read confirms an absence (`absenceRecheckMs`). */
  recheckDelay(): Promise<void>
  /**
   * How long ago the write's last attempt stopped running (it settled, or a
   * restart cut it short), in ms; null while it runs. A transition that went
   * out executes within a block or two, so an absence read long after this
   * is not a write still on its way.
   */
  sinceSettled(): number | null
}

/** How one kind of write runs, and how its outcome is proved. M7b registers one per `WriteOp`. */
export interface WriteHandler<A = unknown> {
  run(args: A, ctx: WriteRunContext): Promise<WriteResult>
  /** Default: prove each unconfirmed document in `ticket.documents` (`ProbeKit.proveDocuments`). */
  probe?(ticket: WriteTicket, args: A | undefined, kit: ProbeKit): Promise<ProbeResult>
  /**
   * Persist the arguments with the ticket (plain engine kv, MMKV on the
   * host), so a retry still works after an engine restart. Off by default:
   * opt in only for arguments that may sit on disk (never DM plaintext or
   * private-feed content).
   */
  persistArgs?: boolean
  /**
   * `run()` reports a stage (`ctx.stage`) before any write call it makes, so
   * a restart that finds this write still `queued` proves that attempt sent
   * nothing: it is `failed`, outcome `not-sent`, and retryable, instead of
   * "may have landed". Off by default: most handlers call lib's write first.
   */
  stagedSends?: boolean
  /**
   * How long `run()` may go without reporting anything (`ctx.stage`,
   * `progress`, `documents`) before the ticket reads `unconfirmed` /
   * `STILL_SENDING`; the run carries on, and its answer still settles the
   * ticket. Default `PENDING_DEADLINE_MS`; null for none.
   */
  deadlineMs?: number | null
}

/**
 * Thrown by a handler for a failure it knows happened before anything was
 * broadcast (for example its own validation, or a read before lib's write
 * call). Without it, a network or rate-limit failure during `run()` counts as
 * "may have landed" (`unconfirmed`), because lib signs, broadcasts and waits
 * inside one call. `cause` is what gets classified.
 */
export class NotSentError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'NotSentError'
  }
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
  /** The running attempt has sent nothing yet: its handler has `stagedSends` and reported no stage so far. */
  unsent?: boolean
  /** When the last attempt stopped running (epoch ms): `ProbeKit.sinceSettled`. */
  settledAt?: number
  /** The attempt whose `run()` has not returned yet (its token), past its deadline or not. */
  running?: number
  /** That attempt's deadline (`WriteHandler.deadlineMs`). */
  deadline?: ReturnType<typeof setTimeout>
  /** The last stage the latest attempt reported, kept past its deadline (which clears the ticket's). */
  stage?: WriteStage | null
  /** Silent re-sends after a passing refusal (`AUTO_RETRY_CODES`) since the write was last started by the host. */
  autoRetries?: number
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
  unsent?: boolean
  settledAt?: number
  /** An attempt was still running: a ticket its deadline made `unconfirmed` was interrupted all the same. */
  running?: boolean
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
  /** `PENDING_DEADLINE_MS` unless a test says otherwise. */
  pendingDeadlineMs?: number
  /** `AUTO_RETRY_DELAYS_MS` unless a test says otherwise (`[]` turns silent re-sends off). */
  autoRetryDelaysMs?: readonly number[]
}

/**
 * The ticket store's own errors. Their `userMessage` is for diagnostics: the
 * host words every one of them itself (the write's own failure sentence, or
 * nothing while it checks), so none is ever shown.
 */
export const RESTARTED_ERROR: EngineErrorData = {
  code: 'ENGINE_RESTARTED',
  consensusCode: null,
  outcome: 'unknown',
  retryable: false,
  userMessage: 'An engine restart cut this write short before it was confirmed: checking whether it landed.',
}

/** A restart cut the write short before it sent anything (`stagedSends`): it may simply be sent again. */
export const RESTARTED_UNSENT_ERROR: EngineErrorData = {
  code: 'ENGINE_RESTARTED',
  consensusCode: null,
  outcome: 'not-sent',
  retryable: true,
  userMessage: 'An engine restart cut this write short before it sent anything.',
}

/**
 * The write's lib call has not answered for its deadline (a DAPI stall: the
 * fetch never settles), or a check ran while it still had not: it may still
 * land, and its answer will say. Never retryable while the call runs.
 */
export const STILL_SENDING_ERROR: EngineErrorData = {
  code: 'STILL_SENDING',
  consensusCode: null,
  outcome: 'unknown',
  retryable: false,
  userMessage: 'Still waiting for this write\'s answer.',
}

/**
 * How long after a write's last attempt stopped running (`ProbeKit.sinceSettled`)
 * a check that does not find it counts as proof it never landed: a
 * transition that went out executes within a block or two (lib's
 * `identity-nonce.ts`), so after this it is not still on its way. Before
 * it, not found is only "not yet": the ticket stays `unconfirmed`
 * (`NOT_FOUND_YET_ERROR`), never retryable, so a like, delete or post still
 * propagating is never rolled back or offered a second send. The host's
 * reconciler checks once more past it (mobile/app `RECHECK_GAPS_MS`).
 */
export const ABSENCE_AFTER_MS = 2 * 60_000

/** A check found nothing, too soon after the attempt stopped to call it absent (`ABSENCE_AFTER_MS`). */
export const NOT_FOUND_YET_ERROR: EngineErrorData = {
  code: 'UNKNOWN',
  consensusCode: null,
  outcome: 'unknown',
  retryable: false,
  userMessage: 'Not seen yet: a write that went out moments ago can take a while to show.',
}

const NOT_FOUND_ERROR: EngineErrorData = {
  code: 'NOT_RECORDED',
  consensusCode: null,
  outcome: 'not-recorded',
  retryable: true,
  userMessage: 'Checked: this write did not land.',
}

export type TicketStore = ReturnType<typeof createTicketStore>

export function createTicketStore(options: TicketStoreOptions) {
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())
  const handlers = new Map<WriteOp, WriteHandler>()
  const records = new Map<string, TicketRecord>()
  const observers = new Set<(ticket: WriteTicket) => void>()
  const absenceRecheckMs = options.absenceRecheckMs ?? 2_000
  const pendingDeadlineMs = options.pendingDeadlineMs ?? PENDING_DEADLINE_MS
  const autoRetryDelaysMs = options.autoRetryDelaysMs ?? AUTO_RETRY_DELAYS_MS
  let attempts = 0

  const clone = (ticket: WriteTicket): WriteTicket => structuredClone(ticket)
  const allConfirmed = (documents: TicketDocument[]) => documents.map(doc => ({ ...doc, confirmed: true }))

  /** Fail closed: only a registered handler that opts in, and never a DM (its arguments are message bodies). */
  const keepsArgs = (op: WriteOp) => handlers.get(op)?.persistArgs === true && !op.startsWith('dm.')

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
    const stored: StoredRecord[] = [...records.values()].map(({ ticket, args, unsent, settledAt, running }) => ({
      ticket: {
        ...ticket,
        createdAt: ticket.createdAt.getTime(),
        updatedAt: ticket.updatedAt.getTime(),
        lastCheckedAt: ticket.lastCheckedAt?.getTime() ?? null,
      },
      ...(args !== undefined && keepsArgs(ticket.op) ? { args } : {}),
      ...(unsent ? { unsent } : {}),
      ...(settledAt !== undefined ? { settledAt } : {}),
      ...(running !== undefined ? { running: true } : {}),
    }))
    options.storage.setItem(WRITES_STORAGE_KEY, JSON.stringify(stored))
  }

  /** Tickets a restart left pending, reported once the API exists. */
  const reconciled: string[] = []

  function load() {
    const stored = readJson<unknown>(options.storage, WRITES_STORAGE_KEY, [])
    const valid = (Array.isArray(stored) ? stored : []).filter((r): r is StoredRecord => typeof r?.ticket?.id === 'string')
    for (const { ticket, args, unsent, settledAt, running } of valid) {
      const restored: WriteTicket = {
        ...ticket,
        createdAt: new Date(ticket.createdAt),
        updatedAt: new Date(ticket.updatedAt),
        lastCheckedAt: ticket.lastCheckedAt === null ? null : new Date(ticket.lastCheckedAt),
      }
      // Older records carry no settle time: count from this boot, which only delays an absence proof.
      let settled = typeof settledAt === 'number' ? settledAt : now()
      // Past its deadline a running attempt's ticket reads `unconfirmed`, but the restart cut it short all the same.
      const timedOut = running === true && restored.state === 'unconfirmed'
      if (restored.state === 'pending' || timedOut) {
        settled = now()
        // Interrupted by a crash or restart, and never re-sent. Still `queued` under a handler that
        // reports a stage before it sends anything, the attempt sent nothing: failed, and it may be
        // sent again (the parts an earlier attempt posted are confirmed documents, kept for the
        // resume). Otherwise whether it went out is unknown. (`unsent` holds until the first stage
        // that may send: a ticket its deadline settled no longer shows that stage. A wait for a
        // parent before any send keeps it.)
        const queued = timedOut || restored.stage === 'queued' || restored.stage === 'waiting-parent'
        const notSent = unsent === true && queued && restored.documents.every(doc => doc.confirmed)
        const interrupted: Partial<WriteTicket> = notSent
          ? { state: 'failed', stage: null, error: RESTARTED_UNSENT_ERROR, retryable: true, updatedAt: new Date(settled) }
          : { state: 'unconfirmed', stage: null, error: RESTARTED_ERROR, retryable: false, updatedAt: new Date(settled) }
        Object.assign(restored, interrupted)
        reconciled.push(restored.id)
      }
      // Without its arguments (never persisted) a write cannot be re-run.
      if (args === undefined) restored.retryable = false
      records.set(restored.id, { ticket: restored, args, settledAt: settled })
    }
  }

  /** Persist the record's ticket and report it. */
  function commit(record: TicketRecord): WriteTicket {
    persist()
    const ticket = clone(record.ticket)
    options.emit('write.status', ticket)
    for (const observer of observers) {
      try {
        observer(clone(ticket))
      } catch {
        // An observer's failure never costs the write its report.
      }
    }
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
    const notSent = error instanceof NotSentError
    const classified = classify(notSent ? error.cause : error, recordOf(id).ticket.op)
    const merged = withDocuments(id, documents)
    // Any failure during run() may come after the broadcast: lib signs, broadcasts and waits in
    // one call. Only a handler's NotSentError, or a failure while it still reported
    // 'waiting-parent' (before any lib write call), proves nothing went out, and only while the
    // ticket names no unconfirmed document: an earlier part (a thread's) may already be out. The
    // attempt's own stage counts, since its deadline clears the ticket's.
    const claimedNotSent = notSent || recordOf(id).stage === 'waiting-parent'
    const partlySent = merged.some(doc => !doc.confirmed)
    const transient = ['NETWORK', 'RATE_LIMITED', 'TIMEOUT'].includes(classified.code)
    let data: EngineErrorData = classified
    let state: 'failed' | 'unconfirmed' = 'failed'
    if (claimedNotSent && partlySent) {
      data = { ...classified, outcome: 'unknown', retryable: false }
      state = 'unconfirmed'
    } else if (notSent) {
      // Proved never sent: a would-be "maybe landed" is plainly failed, and a transient one may be retried.
      if (classified.outcome === 'unknown') data = { ...classified, outcome: 'not-sent', retryable: transient }
    } else if (claimedNotSent) {
      // 'waiting-parent': before lib's write call, so a transport failure there (outcome not-sent)
      // stays failed and retryable; a timeout or a nonce refusal may still be the write's, as before.
      if (classified.outcome === 'unknown') {
        state = 'unconfirmed'
        data = { ...classified, retryable: false }
      }
    } else {
      // Past any pre-broadcast stage, only a verdict (a consensus refusal, a proved absence, or one
      // of lib's pre-signing errors) makes it failed. Anything else (a transport failure such as
      // wasm's "Failed to fetch", a timeout, an unrecognised error) may have landed: unconfirmed,
      // and not retryable until a check proves it absent.
      state = ticketStateFor(classified)
      if (state === 'unconfirmed') data = { ...classified, outcome: 'unknown', retryable: false }
    }
    if (state === 'failed' && data.retryable && resendLater(id, data, merged)) return
    const ticket = update(id, {
      state,
      stage: null,
      error: data,
      retryable: state === 'failed' && data.retryable,
      documents: merged,
    })
    if (data.code === 'NO_KEY') options.onKeyRequired?.(ticket.identityId)
  }

  /**
   * A passing refusal (`AUTO_RETRY_CODES`) with silent re-sends left: the
   * ticket goes back to `pending` (queued) and is sent again after the next
   * backoff, as `retry` would, without the host asking. Returns false when
   * it is the host's to see (another code, no re-sends left, no arguments).
   */
  function resendLater(id: string, error: EngineErrorData, documents: TicketDocument[]): boolean {
    const record = recordOf(id)
    const handler = handlers.get(record.ticket.op)
    const done = record.autoRetries ?? 0
    if (!AUTO_RETRY_CODES.has(error.code) || done >= autoRetryDelaysMs.length || !handler || record.args === undefined) return false
    // A part out but not seen confirmed (a thread's): only the host's Retry, after a check, decides about it.
    if (documents.some(doc => doc.action === 'create' && !doc.confirmed)) return false
    record.autoRetries = done + 1
    // Refused, so nothing of this attempt is out: a restart during the wait finds it unsent.
    record.unsent = true
    update(id, {
      state: 'pending',
      stage: 'queued',
      error: null,
      retryable: false,
      // As `retry`: confirmed documents (thread parts) stay, and a delete names the same document again.
      documents,
      progress: null,
    })
    const waiting = record.ticket
    setTimeout(() => {
      const current = records.get(id)
      // Dismissed meanwhile, or no longer this wait's ticket.
      if (!current || current.ticket !== waiting || current.running !== undefined) return
      if (restartRequired || current.ticket.identityId !== options.currentIdentity()) {
        // The account is changing: it is not this engine's to send. Reported as it was refused.
        update(id, { state: 'failed', stage: null, error, retryable: error.retryable })
        return
      }
      current.unsent = handler.stagedSends === true
      start(id, handler, current.args)
    }, autoRetryDelaysMs[done])
    return true
  }

  /**
   * The deadline passed with the attempt silent: it may still land, so the
   * ticket reads `unconfirmed` (PRD G-3), while the call runs on and its
   * answer settles the ticket. Nothing is re-sent, and nothing is retryable
   * while it runs (`check`, `retry`).
   */
  function expire(id: string, attempt: number): void {
    const record = records.get(id)
    if (record?.running !== attempt || record.ticket.state !== 'pending') return
    record.deadline = undefined
    update(id, { state: 'unconfirmed', stage: null, error: STILL_SENDING_ERROR, retryable: false })
  }

  /** Run (or re-run) a ticket's write in the background. Never throws. */
  function start(id: string, handler: WriteHandler, args: unknown): void {
    const attempt = ++attempts
    const started = recordOf(id)
    started.running = attempt
    started.settledAt = undefined
    started.stage = started.ticket.stage
    const deadlineMs = handler.deadlineMs === undefined ? pendingDeadlineMs : handler.deadlineMs
    /** This attempt's record, while it is the one running. */
    const own = () => {
      const record = records.get(id)
      return record?.running === attempt ? record : undefined
    }
    /** The attempt said something: its deadline starts again (only while the ticket is pending). */
    const arm = () => {
      const record = own()
      if (!record || deadlineMs === null) return
      clearTimeout(record.deadline)
      record.deadline = record.ticket.state === 'pending' ? setTimeout(() => expire(id, attempt), deadlineMs) : undefined
    }
    /**
     * `run()` returned: the attempt stopped, and nothing of it is still on its way out. Returns its
     * record when its answer still settles the ticket: pending, or `unconfirmed` by its deadline.
     * A check that proved it landed meanwhile (`confirmed`) stands.
     */
    const finish = (): TicketRecord | undefined => {
      const record = own()
      if (!record) return undefined
      clearTimeout(record.deadline)
      record.deadline = undefined
      record.running = undefined
      record.settledAt = now()
      record.unsent = false
      if (record.ticket.state === 'pending' || record.ticket.state === 'unconfirmed') return record
      persist()
      return undefined
    }
    const ctx: WriteRunContext = {
      get ticket() { return clone(recordOf(id).ticket) },
      stage: (stage, beforeSend) => {
        // From here the attempt may send: a restart no longer proves it sent nothing.
        const record = recordOf(id)
        if (!beforeSend) record.unsent = false
        record.stage = stage
        // Past its deadline the ticket is no longer pending: it shows no stage.
        if (record.ticket.state === 'pending') update(id, { stage })
        else persist()
        arm()
      },
      // A check that proved the write landed while this attempt ran has the last word.
      progress: (done, total) => {
        if (recordOf(id).ticket.state !== 'confirmed') update(id, { progress: { done, total } })
        arm()
      },
      documents: documents => {
        if (recordOf(id).ticket.state !== 'confirmed') update(id, { documents: withDocuments(id, documents) })
        arm()
      },
      probe: () => probe(clone(recordOf(id).ticket), args),
    }
    arm()
    Promise.resolve()
      .then(() => handler.run(args, ctx))
      .then(result => {
        if (!finish()) return
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
      }, error => {
        if (finish()) fail(id, error)
      })
      .catch(error => {
        // Settling threw: the ticket vanished (dismissed meanwhile), or reporting it did (the store
        // could not write, say). Report it as it stands, or as failed by that error while still
        // pending, so it never sits pending with no attempt running. Best effort.
        const record = records.get(id)
        if (!record || record.running !== undefined) return
        try {
          if (record.ticket.state === 'pending') fail(id, error)
          else commit(record)
        } catch {
          // Nothing more can be reported.
        }
      })
  }

  const recheckDelay = () => new Promise<void>(resolve => setTimeout(resolve, absenceRecheckMs))

  async function proveDocuments(documents: TicketDocument[]): Promise<ProbeResult> {
    // Proving nothing proves nothing: never 'applied' from an empty list.
    if (documents.length === 0) return { state: 'unknown', error: new Error('Nothing to check: this write named no documents') }
    try {
      for (const doc of documents.filter(doc => !doc.confirmed)) {
        let exists = await options.documentExists(doc)
        // One node can lag, either way: a document a create should have added, or a delete
        // removed, counts as not applied only when a second read agrees.
        if (exists !== (doc.action === 'create')) {
          await recheckDelay()
          exists = await options.documentExists(doc)
        }
        if (exists !== (doc.action === 'create')) return { state: 'not-applied' }
      }
      return { state: 'applied' }
    } catch (error) {
      return { state: 'unknown', error }
    }
  }

  async function probe(ticket: WriteTicket, args: unknown): Promise<ProbeResult> {
    const handler = handlers.get(ticket.op)
    const kit: ProbeKit = {
      proveDocuments,
      recheckDelay,
      sinceSettled: () => {
        const record = records.get(ticket.id)
        // Still running (past its deadline or not): some of it may still be on its way out.
        if (!record || record.running !== undefined || record.ticket.state === 'pending' || record.settledAt === undefined) return null
        return now() - record.settledAt
      },
    }
    try {
      if (handler?.probe) return await handler.probe(clone(ticket), args, kit)
    } catch (error) {
      return { state: 'unknown', error }
    }
    return proveDocuments(ticket.documents)
  }

  load()
  // After construction: the host's subscription (and the entry's dispatcher) exist by then, and
  // the API has registered its handlers, so the rewrite keeps the arguments they persist.
  queueMicrotask(() => {
    if (records.size > 0) persist()
    for (const id of reconciled) {
      const record = records.get(id)
      if (record?.ticket.identityId === options.currentIdentity()) options.emit('write.status', clone(record.ticket))
    }
  })

  /** Set once an account switch is under way: nothing more until the engine restarts. */
  let restartRequired = false
  function assertUsable(): void {
    if (restartRequired) throw new RpcError('The engine must restart to finish switching accounts', 'RESTART_REQUIRED')
  }

  return {
    /** Register how `op` runs; M7b's write methods each register one. */
    register<A>(op: WriteOp, handler: WriteHandler<A>): void {
      handlers.set(op, handler)
    },

    /**
     * Call `observer` with every ticket transition the store reports
     * (`write.status`), for engine-side caches a write makes stale. Returns
     * the unsubscribe.
     */
    observe(observer: (ticket: WriteTicket) => void): () => void {
      observers.add(observer)
      return () => { observers.delete(observer) }
    },

    /**
     * Issue a ticket and start the write in the background. The returned
     * ticket is `pending`; every later transition is a `write.status` event.
     */
    submit<A>(request: WriteRequest<A>): WriteTicket {
      assertUsable()
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
        unsent: handler.stagedSends === true,
      }
      records.set(record.ticket.id, record)
      const issued = commit(record)
      start(issued.id, handler, request.args)
      return issued
    },

    /** The active account's tickets: pending, unconfirmed and failed ones, and those confirmed in the last 10 minutes. */
    list(): WriteTicket[] {
      assertUsable()
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
      assertUsable()
      const { ticket, args } = ownRecord(id)
      if (ticket.state !== 'unconfirmed') return clone(ticket)
      const result = await probe(ticket, args)
      const lastCheckedAt = new Date(now())
      // Dismissed, retried or checked again while the probe ran: its answer is stale.
      // (Every update replaces the ticket object, so identity tells whether it changed.)
      const current = records.get(id)?.ticket
      if (current !== ticket) return current ? clone(current) : { ...clone(ticket), lastCheckedAt }
      // What the probe found beyond the ticket's documents (a post found by its content) is kept either way.
      const documents = withDocuments(id, result.documents)
      // Its call still runs (past its deadline): only a landing is proved. Not found may mean still
      // on its way, and a retry beside the running call could post it twice.
      if (result.state !== 'applied' && records.get(id)?.running !== undefined) {
        return update(id, { error: STILL_SENDING_ERROR, retryable: false, lastCheckedAt, documents })
      }
      switch (result.state) {
        case 'applied':
          return update(id, { state: 'confirmed', error: null, retryable: false, lastCheckedAt, documents: allConfirmed(documents) })
        case 'not-applied': {
          // Not found this soon after the attempt stopped may be a transition still on its way.
          const settledAt = records.get(id)?.settledAt
          if (settledAt === undefined || now() - settledAt < ABSENCE_AFTER_MS) {
            return update(id, { error: NOT_FOUND_YET_ERROR, retryable: false, lastCheckedAt, documents })
          }
          return update(id, { error: NOT_FOUND_ERROR, retryable: true, lastCheckedAt, documents })
        }
        case 'unknown':
          return update(id, { error: { ...classify(result.error, ticket.op), retryable: false }, retryable: false, lastCheckedAt, documents })
      }
    },

    /**
     * Re-run a write with a fresh nonce, only where ENGINE.md §7.2 allows it:
     * a failed write that was refused retryably or never sent, or an
     * unconfirmed one a check proved absent. Otherwise `NOT_RETRYABLE`.
     */
    async retry(id: string): Promise<WriteTicket> {
      assertUsable()
      const { ticket, args, running } = ownRecord(id)
      const handler = handlers.get(ticket.op)
      if (ticket.state === 'pending' || !ticket.retryable || running !== undefined) {
        throw new RpcError('This write cannot be retried now', 'NOT_RETRYABLE')
      }
      if (!handler || args === undefined) {
        throw new RpcError('This write can no longer be retried: start it again', 'NOT_RETRYABLE')
      }
      // The earlier attempt's unproven documents are gone (proved absent, or refused): a fresh
      // nonce gives fresh ids, which the new attempt records. Confirmed ones (thread parts) stay.
      // A delete names the same document again, so its id stays for the next check.
      const documents = ticket.documents.filter(doc => doc.confirmed || doc.action === 'delete')
      recordOf(id).unsent = handler.stagedSends === true
      // The earlier attempt's progress ("2 of 2") says nothing about this one, which may write less.
      recordOf(id).autoRetries = 0
      const restarted = update(id, { state: 'pending', stage: 'queued', error: null, retryable: false, documents, progress: null })
      start(id, handler, args)
      return restarted
    },

    /** Forget a settled ticket. A pending one cannot be dismissed. */
    async dismiss(id: string): Promise<void> {
      assertUsable()
      if (!records.has(id)) return
      const record = ownRecord(id)
      if (record.ticket.state === 'pending') throw new RpcError('A pending write cannot be dismissed', 'BAD_REQUEST')
      records.delete(id)
      persist()
    },

    /** An account switch is under way (session.switchAccount): refuse everything until the engine restarts. */
    requireRestart(): void {
      restartRequired = true
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
