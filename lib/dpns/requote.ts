/**
 * "Review the new deposit" after a batch: which names are quoted again, and
 * what the results screen shows when the new review has nothing to register.
 * Pure (unit-tested).
 */
import type { UsernameEntry } from '@/lib/types'
import type { DpnsQuote } from './registration-quote'

export interface RequoteBatch {
  /** The names whose deposit changed, to check and quote again: listed in the results until one is sent. */
  requoted: UsernameEntry[]
  /**
   * What the review lists: those names, then the ones still being confirmed (unchecked, so its
   * Register leaves them to the results screen's continue), then the ones that failed.
   */
  review: UsernameEntry[]
  /** The review's names with what the new check found for the re-quoted ones, so one not sent keeps its reason. */
  reviewed: (checked: UsernameEntry[]) => UsernameEntry[]
  /** The results screen again, for a new review with nothing to register, given the names as it checked them. */
  unreviewable: (checked: UsernameEntry[]) => UsernameEntry[]
}

/** A re-quoted name as the new check left it: taken for good, or still to review again with the check's reason. */
function recheck(entry: UsernameEntry, now: UsernameEntry | undefined): UsernameEntry {
  if (now?.status === 'taken') return { ...entry, requote: false, registrationError: `${entry.label}.dash is taken now.` }
  if (now?.status === 'invalid' && now.validationError) return { ...entry, registrationError: now.validationError }
  return entry
}

/**
 * Split a finished batch for a new quote. A name still being confirmed keeps
 * the label and approval it was sent with, whichever quote the review holds
 * next, so continuing it never needs that quote.
 */
export function requoteBatch(usernames: UsernameEntry[], quote: DpnsQuote | null): RequoteBatch {
  const bound = (entry: UsernameEntry): UsernameEntry => {
    if (entry.approval) return entry
    const reviewed = quote?.names.find((name) => name.label === entry.label)
    return reviewed ? { ...entry, approval: { contestFund: reviewed.contestFund, plan: reviewed.plan } } : entry
  }
  const unchecked = (entry: UsernameEntry): UsernameEntry => ({ ...entry, status: 'pending' })
  const changed = usernames.filter((u) => u.registered === false && u.requote)
  const requoted = changed.map((u): UsernameEntry => ({
    id: u.id,
    label: u.label,
    status: 'pending',
    isContested: u.isContested,
    registered: false,
    requote: true,
    registrationError: u.registrationError,
  }))
  const changedIds = new Set(changed.map((u) => u.id))
  const carried = usernames.filter((u) => u.registered === false && u.pending).map(bound)
  const failed = usernames.filter((u) => u.registered === false && !u.pending && !u.requote)
  const carriedById = new Map(carried.map((u) => [u.id, u]))
  return {
    requoted,
    review: [
      ...requoted,
      ...carried.map(unchecked),
      ...failed.map((u): UsernameEntry => ({ ...u, status: 'invalid', validationError: u.registrationError })),
    ],
    reviewed: (checked) => checked.map((u) => (changedIds.has(u.id) ? recheck(u, u) : u)),
    unreviewable: (checked) => usernames.map((u) =>
      carriedById.get(u.id) ?? (changedIds.has(u.id) ? recheck(u, checked.find((c) => c.id === u.id)) : u)
    ),
  }
}
