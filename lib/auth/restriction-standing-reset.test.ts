import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clearSocial, clearBlog } = vi.hoisted(() => ({ clearSocial: vi.fn(), clearBlog: vi.fn() }))
vi.mock('@/lib/services/restriction-service', () => ({
  restrictionServiceFor: (contract: 'social' | 'blog') => ({ clear: contract === 'social' ? clearSocial : clearBlog }),
}))

import { clearRestrictionsOnIdentityChange } from './restriction-standing-reset'

type State = { user: { identityId: string } | null }

function harness(initial: State) {
  let listener: ((state: State) => void) | null = null
  const unsubscribe = vi.fn()
  const stop = clearRestrictionsOnIdentityChange(initial, (next) => {
    listener = next
    return unsubscribe
  })
  return { emit: (state: State) => listener?.(state), stop, unsubscribe }
}

const as = (identityId: string): State => ({ user: { identityId } })

beforeEach(() => {
  clearSocial.mockReset()
  clearBlog.mockReset()
})

describe('clearRestrictionsOnIdentityChange', () => {
  it('forgets the social and blog standings on sign-out', () => {
    const { emit } = harness(as('A'))
    emit({ user: null })
    expect(clearSocial).toHaveBeenCalledTimes(1)
    expect(clearBlog).toHaveBeenCalledTimes(1)
  })

  it('forgets them on a switch to another account, and on a sign-in', () => {
    const { emit } = harness(as('A'))
    emit(as('B'))
    emit({ user: null })
    emit(as('C'))
    expect(clearSocial).toHaveBeenCalledTimes(3)
  })

  it('leaves them alone while the same identity stays signed in (balance and username refreshes)', () => {
    const { emit } = harness(as('A'))
    emit(as('A'))
    emit({ user: { identityId: 'A' } })
    expect(clearSocial).not.toHaveBeenCalled()
    expect(clearBlog).not.toHaveBeenCalled()
  })

  it('returns the subscription\'s unsubscribe', () => {
    const { stop, unsubscribe } = harness(as('A'))
    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
