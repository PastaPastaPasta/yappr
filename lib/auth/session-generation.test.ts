import { describe, expect, it } from 'vitest'
import { bumpSessionGeneration, sessionGeneration, sessionGuard } from './session-generation'

describe('sessionGuard', () => {
  it('holds while the session is unchanged', () => {
    const stillCurrent = sessionGuard()
    expect(stillCurrent()).toBe(true)
  })

  it('a bump between start and finish discards', () => {
    const stillCurrent = sessionGuard()
    bumpSessionGeneration()
    expect(stillCurrent()).toBe(false)
  })

  it('a later session never matches an earlier one, even after returning to the same identity', () => {
    const before = sessionGeneration()
    const stillCurrent = sessionGuard()
    bumpSessionGeneration()
    bumpSessionGeneration()
    expect(sessionGeneration()).toBe(before + 2)
    expect(stillCurrent()).toBe(false)
  })
})
