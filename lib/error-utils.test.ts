/**
 * `isImmutablePropertyChangedError` decides two things that matter: whether the
 * user is told the failure is permanent, and whether `retryPostCreation`
 * bothers retrying. Both a miss and a false positive are harmful, so the
 * matcher is pinned against Drive's real phrasing AND against the strings it
 * must NOT claim.
 */
import { describe, expect, it } from 'vitest'
import { categorizeError, isImmutablePropertyChangedError } from './error-utils'

describe('isImmutablePropertyChangedError', () => {
  it.each([
    // Drive's rendered message (rs-dpp document_immutable_property_changed_error.rs).
    "property 'hashtag' of document 9t2eeU6CjzJbpckxXWhgaApbdRB4dVDHFNfcEum9KS2H (type 'post') is immutable and cannot be changed by a replace",
    'DocumentImmutablePropertyChangedError: property \'language\' is immutable and cannot be changed by a replace',
    'state transition rejected, code=40128',
    'Consensus error code: 40128',
    // extractErrorMessage's JSON.stringify fallback, for an error with no `message`.
    '{"code":40128,"documentType":"post"}',
  ])('recognizes %s', (message) => {
    expect(isImmutablePropertyChangedError(new Error(message))).toBe(true)
  })

  it.each([
    // "40128" inside an ordinary millisecond timestamp and a credit amount:
    // the bare-substring form of this matcher would claim both.
    'broadcast timed out at 1740128000000',
    'insufficient balance: 40128000 credits required',
    // Neighbouring consensus errors must keep their own handling.
    "the document's hashtag does not agree with the referenced document's hashtag (propertyAgreement on postId), code=40127",
    'duplicate unique properties, code=40105',
    'no available addresses',
  ])('does not claim %s', (message) => {
    expect(isImmutablePropertyChangedError(new Error(message))).toBe(false)
  })

  it('categorizes a frozen-property refusal as permanent rather than a retry or a balance problem', () => {
    expect(categorizeError(new Error("property 'language' is immutable and cannot be changed by a replace")))
      .toBe('Part of this post can no longer be changed once it has been published.')
  })
})
