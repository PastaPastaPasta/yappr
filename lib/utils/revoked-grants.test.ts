import { describe, expect, it } from 'vitest'
import { withoutRevokedGrants } from './revoked-grants'

describe('withoutRevokedGrants', () => {
  const grant = (recipientId: string, grantedAt: number) => ({ recipientId, grantedAt, leafIndex: 0 })

  it('keeps every grant when nothing was revoked', () => {
    const grants = [grant('a', 1), grant('b', 2)]
    expect(withoutRevokedGrants(grants, new Map())).toEqual(grants)
  })

  it('hides a stale read of the grant that was revoked', () => {
    const revoked = new Map([['a', 1000]])
    expect(withoutRevokedGrants([grant('a', 1000), grant('b', 900)], revoked)).toEqual([grant('b', 900)])
  })

  it('shows a follower again once they are re-approved with a newer grant', () => {
    const revoked = new Map([['a', 1000]])
    expect(withoutRevokedGrants([grant('a', 5000)], revoked)).toEqual([grant('a', 5000)])
  })
})
