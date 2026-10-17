import { describe, expect, it } from 'vitest'
import { pendingWork } from './pending-work'

describe('pendingWork', () => {
  it('stays busy until the last overlapping operation ends (two renewals, the first ending first)', () => {
    const renewals = pendingWork()
    const first = renewals.start()
    const second = renewals.start()

    first()
    first()
    expect(renewals.busy).toBe(true)
    second()
    expect(renewals.busy).toBe(false)
  })
})
