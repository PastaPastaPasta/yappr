/**
 * `isImmutablePropertyChangedError` decides two things that matter: whether the
 * user is told the failure is permanent, and whether `retryPostCreation`
 * bothers retrying. Both a miss and a false positive are harmful, so the
 * matcher is pinned against Drive's real phrasing AND against the strings it
 * must NOT claim.
 */
import { describe, expect, it } from 'vitest'
import {
  categorizeError,
  isImmutablePropertyChangedError,
  isPropertyAgreementError,
  isWriteGateError,
} from './error-utils'

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

// The two consensus errors the beta.2 contract re-cut relies on, quoted from
// their `#[error(...)]` formats in rs-dpp so the classifiers are pinned to what
// Drive actually renders rather than to a paraphrase:
//   referenced_document_property_mismatch_error.rs   (state code 40127)
//   document_immutable_property_changed_error.rs     (state code 40128)
const VALUE_MISMATCH =
  "the document's sellerId does not agree with the referenced document's sellerId (propertyAgreement on orderId)"
const WRITER_GATE =
  "the document's $ownerId does not agree with the referenced document's sellerId (propertyAgreement on orderId)"
const IMMUTABLE =
  "property 'publishedAt' of document 8Xv3 (type 'blogPost') is immutable and cannot be changed by a replace"

describe('propertyAgreement rejections (40127)', () => {
  it('recognises a value pair that disagrees with the referenced document', () => {
    expect(isPropertyAgreementError(new Error(VALUE_MISMATCH))).toBe(true)
    expect(isWriteGateError(new Error(VALUE_MISMATCH))).toBe(false)
  })

  it('recognises a writer gate by $ownerId on the REFERRING side', () => {
    expect(isPropertyAgreementError(new Error(WRITER_GATE))).toBe(true)
    expect(isWriteGateError(new Error(WRITER_GATE))).toBe(true)
  })

  it('does not treat an unrelated failure as an agreement rejection', () => {
    expect(isPropertyAgreementError(new Error('wait for state transition result timed out'))).toBe(false)
    expect(isWriteGateError(new Error('wait for state transition result timed out'))).toBe(false)
  })

  it('does not fire on the digits appearing inside an id or an amount', () => {
    // The bare code is matched on word boundaries, so a document id or a credit
    // figure carrying the same five digits is not a 40127.
    expect(isPropertyAgreementError(new Error('insufficient balance: required 4012700 credits'))).toBe(false)
    expect(isImmutablePropertyChangedError(new Error('document 8Xv40128Qr not found'))).toBe(false)
    // A real one still matches by code alone.
    expect(isPropertyAgreementError(new Error('state error 40127'))).toBe(true)
  })

  it('tells the user who may act, not to retry, when a gate refuses them', () => {
    expect(categorizeError(new Error(WRITER_GATE))).toMatch(/only the owner/i)
    expect(categorizeError(new Error(VALUE_MISMATCH))).toMatch(/reload/i)
  })
})
