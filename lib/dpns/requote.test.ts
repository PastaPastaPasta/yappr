import { describe, expect, it } from 'vitest'
import { requoteBatch } from './requote'
import { totalQuote } from './registration-quote'
import type { UsernameEntry } from '@/lib/types'

const FUND = { indexName: 'parentNameAndLabel', credits: 10_000_000_000n }
const PLAN = { preorder: true, deletePreorder: false, domain: true }

const changed: UsernameEntry = { id: 'a', label: 'alex', status: 'contested', isContested: true, registered: false, requote: true, registrationError: 'The vote deposit changed' }
const pending: UsernameEntry = { id: 'b', label: 'bobby', status: 'contested', isContested: true, registered: false, pending: true, registrationError: 'Still being confirmed' }
const done: UsernameEntry = { id: 'c', label: 'carol22', status: 'available', isContested: false, registered: true }
const quote = totalQuote([
  { label: 'alex', contestFund: FUND, fees: 70_000_000n, plan: PLAN },
  { label: 'bobby', contestFund: FUND, fees: 70_000_000n, plan: PLAN },
])

describe('reviewing a new deposit', () => {
  it('quotes only the changed names and keeps a pending name bound to the approval it was sent with', () => {
    const batch = requoteBatch([changed, pending, done], quote)
    expect(batch.requoted).toEqual([{ id: 'a', label: 'alex', status: 'pending', isContested: true, registered: false, requote: true, registrationError: 'The vote deposit changed' }])
    expect(batch.review.map((u) => u.id)).toEqual(['a', 'b'])
    // Listed, but not registrable from the review: its deposit isn't in the new quote.
    expect(batch.review[1]).toMatchObject({ status: 'pending', pending: true, approval: { contestFund: FUND, plan: PLAN } })
    // A second re-quote keeps the first approval, though the quote no longer lists the name.
    const again = requoteBatch(batch.review.map((u) => (u.id === 'a' ? changed : u)), totalQuote([]))
    expect(again.review[1].approval).toEqual({ contestFund: FUND, plan: PLAN })
  })

  it('keeps a re-quoted name that turned out taken in the results when another one is still registrable', () => {
    const other: UsernameEntry = { ...changed, id: 'd', label: 'dana' }
    const batch = requoteBatch([changed, other, pending], quote)
    const checked = batch.review.map((u) => (u.id === 'a' ? { ...u, status: 'taken' as const } : u.id === 'd' ? { ...u, status: 'contested' as const } : u))
    const review = batch.reviewed(checked)
    // Not sent from the review, so the results show it with its new reason, not offered again.
    expect(review[0]).toMatchObject({ registered: false, requote: false, registrationError: 'alex.dash is taken now.' })
    expect(review[1]).toMatchObject({ status: 'contested', registered: false, requote: true })
  })

  it('goes back to the results, pending names still continuable, when the new review has nothing to register', () => {
    const batch = requoteBatch([changed, pending, done], quote)
    const taken = batch.unreviewable([{ ...batch.requoted[0], status: 'taken' }, ...batch.review.slice(1)])
    expect(taken.map((u) => u.id)).toEqual(['a', 'b', 'c'])
    expect(taken[0]).toMatchObject({ registered: false, requote: false, registrationError: 'alex.dash is taken now.' })
    expect(taken[1]).toMatchObject({ pending: true, approval: { contestFund: FUND, plan: PLAN } })
    expect(taken[2]).toBe(done)
    // The price couldn't be read: the name can be reviewed again.
    const unread = batch.unreviewable([{ ...batch.requoted[0], status: 'contested' }, ...batch.review.slice(1)])
    expect(unread[0]).toBe(changed)
  })
})
