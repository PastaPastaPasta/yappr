/**
 * `retryPostCreation` wraps a create that has already reached consensus on
 * failure paths, so retrying a PERMANENT rejection is not merely wasteful: each
 * attempt builds a fresh transition under a fresh nonce, pays for its own
 * refusal, and ends identically. The protocol-14 family is the sharp case,
 * because several of its members render as "consensus error" text that the
 * retry allowlist would otherwise burn three attempts on.
 */
import { describe, expect, it, vi } from 'vitest'
import { retryPostCreation } from './retry-utils'

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const permanent: Array<[string, string]> = [
  ['40132 no action fee agreement', 'consensus error: the transition carries no action fee agreement, code=40132'],
  ['40133 mismatched agreement', 'consensus error code=40133'],
  ['40134 multiplier not tolerated', 'consensus error code=40134'],
  ['40129 gas payer not offered', 'consensus error code=40129'],
  ['40222 sponsor short of credits', 'consensus error code=40222'],
  ['41107 banned', 'consensus error code=41107'],
  ['41108 suspended', 'consensus error code=41108'],
]

describe('retryPostCreation', () => {
  it.each(permanent)('does not retry %s', async (_label, message) => {
    const operation = vi.fn().mockRejectedValue(new Error(message))
    const result = await retryPostCreation(operation)
    expect(result.success).toBe(false)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('still retries a transient failure', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce('posted')
    const result = await retryPostCreation(operation, { initialDelayMs: 1 })
    expect(result).toMatchObject({ success: true, data: 'posted', attempts: 2 })
  })
})
