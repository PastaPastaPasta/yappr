/**
 * "Review the new deposit" after a batch: which names are quoted again, and
 * what the results screen shows when the new review has nothing to register.
 * Pure (unit-tested).
 */
import type { UsernameEntry } from '@/lib/types'
import type { DpnsQuote } from './registration-quote'

export interface RequoteBatch {
  /** The names whose deposit changed, to check and quote again. */
  requoted: UsernameEntry[]
  /**
   * What the review lists: those names, then the ones still being confirmed (unchecked, so its
   * Register leaves them to the results screen's continue), then the ones that failed.
   */
  review: UsernameEntry[]
  /** The results screen again, for a new review with nothing to register, given the names as it checked them. */
  unreviewable: (checked: UsernameEntry[]) => UsernameEntry[]
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
  const requoted = changed.map((u): UsernameEntry => ({ id: u.id, label: u.label, status: 'pending', isContested: u.isContested }))
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
    unreviewable: (checked) => usernames.map((u) => {
      const carriedEntry = carriedById.get(u.id)
      if (carriedEntry) return carriedEntry
      if (u.registered !== false || !u.requote) return u
      const now = checked.find((c) => c.id === u.id)
      if (now?.status === 'taken') return { ...u, requote: false, registrationError: `${u.label}.dash is taken now.` }
      if (now?.status === 'invalid' && now.validationError) return { ...u, registrationError: now.validationError }
      return u
    }),
  }
}
