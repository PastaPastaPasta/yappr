/**
 * `isImmutablePropertyChangedError` decides two things that matter: whether the
 * user is told the failure is permanent, and whether `retryPostCreation`
 * bothers retrying. Both a miss and a false positive are harmful, so the
 * matcher is pinned against Drive's real phrasing AND against the strings it
 * must NOT claim.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  categorizeError,
  classifyModerationError,
  isActionFeeAgreementError,
  isDocumentPropertyRuleError,
  isModerationNotYetSeatedError,
  isModeratorsShareMismatchError,
  isPropertyMaxBytesError,
  isReferenceNotFoundError,
  isReferenceRequirementError,
  isBarredFromContractError,
  isFeeMultiplierNotToleratedError,
  isGasPayerError,
  isGasSponsorShortError,
  isImmutablePropertyChangedError,
  isInvalidDocumentIdError,
  isModerationBarredError,
  isOncePerIdentityAlreadyClaimedError,
  isPermanentProtocol14Error,
  isPropertyAgreementError,
  isReferencedTypeNotDeletableError,
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

  it('recognises a frozen blogPost property as the same permanent 40128', () => {
    // The write-once `publishedAt` on blogPost — the one place in the app where
    // this rejection is a state, not a bug: the post is already published.
    expect(isImmutablePropertyChangedError(new Error(IMMUTABLE))).toBe(true)
  })

  it('tells the user who may act, not to retry, when a gate refuses them', () => {
    expect(categorizeError(new Error(WRITER_GATE))).toMatch(/only the owner/i)
    expect(categorizeError(new Error(VALUE_MISMATCH))).toMatch(/reload/i)
  })
})

// Protocol 14 (Platform 4.2.0-beta.3) rejections the app can hit against the
// live v7 contract. Each message is quoted from its `#[error(...)]` format in
// rs-dpp so the matchers pin what Drive renders, and each is asserted permanent
// (never retried, never categorised as a network or YAPP problem).
describe('protocol-14 rejections', () => {
  const cases: Array<[string, (error: unknown) => boolean, string, RegExp]> = [
    // basic 10405 — invalid_document_transition_id_error.rs
    ['InvalidDocumentTransitionIdError', isInvalidDocumentIdError,
      'Invalid document transition id 9t2eeU6CjzJbpckxXWhgaApbdRB4dVDHFNfcEum9KS2H, expected 8Xv3QrLm2nKqP5wYtZcVbNdFgHjJkLpRsTuWxYzAbCdE', /report this/i],
    ['10405 by labelled code', isInvalidDocumentIdError, 'state transition rejected, code=10405', /report this/i],
    // state 41107 / 41108 / 41114 — contract_moderation/*.rs
    ['ContractUserBannedError', isModerationBarredError,
      'Identity 9t2eeU6CjzJbpckxXWhgaApbdRB4dVDHFNfcEum9KS2H is banned on contract 8Xv3QrLm2nKqP5wYtZcVbNdFgHjJkLpRsTuWxYzAbCdE and can not act on its documents', /banned or suspended/i],
    ['ContractUserSuspendedError', isModerationBarredError,
      'Identity 9t2e is suspended on contract 8Xv3 until 1790000000000 and can not act on its documents', /banned or suspended/i],
    ['ContractModerationCounterpartyBarredError', isModerationBarredError,
      'Identity 9t2e is banned or suspended on contract 8Xv3 and can not be the recipient of a document', /banned or suspended/i],
    ['41108 by labelled code', isModerationBarredError, '{"code":41108,"identityId":"9t2e"}', /banned or suspended/i],
    // state 40129 / 40130 / 40222 — gas payer
    ['GasFeesPaidByNotAllowedError', isGasPayerError,
      'Document create of type post asks for gas fees paid by contract owner, but the document type only offers document owner', /try again later/i],
    ['InconsistentGasFeesPaidByInBatchError', isGasPayerError,
      'The gas of a batch is paid by one identity: it cannot be paid by the document owner for one transition and by the contract owner for another', /try again later/i],
    ['GasSponsorInsufficientBalanceError', isGasPayerError,
      'The contract owner 9t2e sponsoring the gas has balance 1200, but 38000 is required', /couldn't cover the network fee/i],
    ['40222 by labelled code', isGasPayerError, 'consensus error code=40222', /couldn't cover the network fee/i],
    // state 40132 / 40133 / 40134 — action fee agreement
    ['DocumentActionFeeAgreementNotSetError', isActionFeeAgreementError,
      'Document create of type post charges an action fee of 1000 credits to the owner and 500 credits to the moderators (fixed pricing), and the transition carries no action fee agreement', /out of date/i],
    ['DocumentActionFeeAgreementMismatchError', isActionFeeAgreementError,
      'Document create of type post charges an action fee of 1000 credits to the owner and 500 credits to the moderators (fixed pricing), but the transition agreed to 100 and 50 credits (fixed pricing)', /out of date/i],
    ['DocumentActionFeeMultiplierNotToleratedError', isActionFeeAgreementError,
      'Document create of type post agreed to an action fee priced with a fee multiplier of 1000 permille and at most 10% more, but the fee multiplier is 1500 permille', /fee level changed/i],
    ['40133 by labelled code', isActionFeeAgreementError, 'rejected: code=40133', /out of date/i],
    // state 40131 — referenced_document_type_not_deletable_error.rs
    ['ReferencedDocumentTypeNotDeletableError', isReferencedTypeNotDeletableError,
      'documents of referenced document type post in contract 8Xv3 can not be deleted; a deletableDocument reference at path postId requires a document type whose documents can be deleted, and a permanentDocument reference is the one for a document type with canBeDeleted: false', /report this/i],
    // state 40722 — token_once_per_identity_distribution_already_claimed_error.rs
    ['TokenOncePerIdentityDistributionAlreadyClaimedError', isOncePerIdentityAlreadyClaimedError,
      "Token claim error: identity '9t2e' already claimed the once-per-identity distribution of token 'AwyQ' at 1790000000000", /already claimed/i],
    ['40722 by labelled code', isOncePerIdentityAlreadyClaimedError, '{"code":40722}', /already claimed/i],
  ]

  it.each(cases)('%s is recognised, permanent and given its own message', (_label, matcher, message, expected) => {
    const error = new Error(message)
    expect(matcher(error)).toBe(true)
    expect(isPermanentProtocol14Error(error)).toBe(true)
    expect(categorizeError(error)).toMatch(expected)
  })

  it.each([
    // Digits inside timestamps, amounts and ids must not read as codes.
    'broadcast timed out at 1741107000000',
    'insufficient balance: 40129000 credits required',
    'document 8Xv40722Qr not found',
    // The 40105 duplicate and 40127 agreement keep their own handling.
    'duplicate unique properties, code=40105',
    "the document's hashtag does not agree with the referenced document's hashtag (propertyAgreement on postId), code=40127",
    // A frozen TOKEN account is a different situation from a moderation ban.
    'Identity 9t2e account is frozen for token AwyQ. Action attempted: Document create token payment',
    // "is not frozen" from destroyFrozen, and a plain transport failure.
    'wait for state transition result timed out',
    'no available addresses',
  ])('does not claim %s', (message) => {
    expect(isPermanentProtocol14Error(new Error(message))).toBe(false)
  })

  it('splits the two gas-payer situations: a short sponsor is not the client asking for the wrong payer', () => {
    const sponsorShort = new Error('The contract owner 9t2e sponsoring the gas has balance 1200, but 38000 is required')
    const wrongPayer = new Error('Document create of type post asks for gas fees paid by contract owner, but the document type only offers document owner')
    // Both stay in the gas-payer family (and permanent), but only one is the sponsor.
    expect([isGasPayerError(sponsorShort), isGasPayerError(wrongPayer)]).toEqual([true, true])
    expect([isGasSponsorShortError(sponsorShort), isGasSponsorShortError(wrongPayer)]).toEqual([true, false])
    // The sponsor case is the only one a user can route around (pay in credits).
    expect(categorizeError(sponsorShort)).toMatch(/credits/i)
  })

  it('splits 40134 from the stale-client members of the fee-agreement family', () => {
    const multiplier = new Error('Document create of type post agreed to an action fee priced with a fee multiplier of 1000 permille and at most 10% more, but the fee multiplier is 1500 permille')
    const notSet = new Error('Document create of type post charges an action fee of 1000 credits to the owner and 500 credits to the moderators (fixed pricing), and the transition carries no action fee agreement')
    expect([isActionFeeAgreementError(multiplier), isActionFeeAgreementError(notSet)]).toEqual([true, true])
    // Only 40134 tells the write path its cached multiplier is stale.
    expect([isFeeMultiplierNotToleratedError(multiplier), isFeeMultiplierNotToleratedError(notSet)]).toEqual([true, false])
    // …and it is not "reload the app": nothing about the client was wrong.
    expect(categorizeError(multiplier)).not.toMatch(/out of date/i)
  })

  it('recognises the SIGNER being barred without claiming the counterparty case', () => {
    const banned = new Error('Identity 9t2e is banned on contract 8Xv3 and can not act on its documents')
    const suspended = new Error('{"code":41108,"identityId":"9t2e"}')
    const counterparty = new Error('Identity 9t2e is banned or suspended on contract 8Xv3 and can not be the recipient of a document')
    expect([banned, suspended].map(isBarredFromContractError)).toEqual([true, true])
    // 41114 bars the OTHER party, so the viewer's own standing explains nothing.
    expect(isBarredFromContractError(counterparty)).toBe(false)
    expect(isModerationBarredError(counterparty)).toBe(true)
    // A frozen token account is a different situation from a moderation ban.
    expect(isBarredFromContractError(new Error('Identity 9t2e account is frozen for token AwyQ'))).toBe(false)
  })

  it('offers the credits way out of an insufficient balance only where the contract has one', async () => {
    const shortOfYapp = new Error('Identity 9t2e does not have enough token balance, code=40700')
    // v8 prices post/reply/like optionally, so credits are a real alternative.
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v8')
    const v8 = await import('./error-utils')
    expect(v8.categorizeError(shortOfYapp)).toMatch(/credits/i)
    // v7's costs are required: naming credits there would be advice that cannot work.
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v7')
    const v7 = await import('./error-utils')
    expect(v7.categorizeError(shortOfYapp)).not.toMatch(/credits/i)
    expect(v7.categorizeError(shortOfYapp)).toMatch(/enough YAPP/i)
  })

  it('keeps the frozen-account message for a frozen token account, not the moderation one', () => {
    expect(categorizeError(new Error('Identity 9t2e account is frozen for token AwyQ. Action attempted: Document create token payment')))
      .toMatch(/suspended \(frozen\)/i)
  })
})

describe('4.2.0-beta.4 rejections', () => {
  // Messages transcribed from the rs-dpp `#[error(...)]` formats at tag v4.2.0-beta.4.
  const cases: Array<[string, (error: unknown) => boolean, string, RegExp]> = [
    ['10419 DocumentPropertyNotDistinctError', isDocumentPropertyRuleError,
      'Document type "follow" property "followingId" must differ from "$ownerId", but the two values are equal', /combination/i],
    ['10421 DocumentPropertyMaxBytesExceededError', isPropertyMaxBytesError,
      'Property content is 2140 bytes in UTF-8, over its maxBytes of 2000', /shorten it/i],
    ['10422 DocumentPropertyConstraintViolatedError', isDocumentPropertyRuleError,
      'A document of type "listing" breaks its propertyConstraints rule "minPrice <= maxPrice": 30 > 20', /combination/i],
    ['40135 ReferencedContractRequirementNotMetError', isReferenceRequirementError,
      "referenced contract 8Xv3 for path storeContractId does not meet the reference's requirement moderation elected", /report this/i],
    ['40136 ReferencedIdentityKeyRequirementNotMetError', isReferenceRequirementError,
      'referenced public key 3 of identity 9t2e for dm.recipientKeyId has purpose AUTHENTICATION, the reference requires ENCRYPTION', /report this/i],
    ['40137 ReferencedDocumentLookupInvalidError', isReferenceRequirementError,
      'invalid refersTo lookup through index byName declared at storeName: the index is not unique', /report this/i],
    ['40138 ReferencedDocumentListInvalidError', isReferenceRequirementError,
      'invalid refersTo listElement into inList tags declared at tag: not a list', /report this/i],
    ['40139 DocumentActionFeeModeratorsShareMismatchError', isActionFeeAgreementError,
      "Document create of type post declares a moderators fee of 80000000 credits; the transition agreed to 40000000, which is not the seated moderation charter's 60% share of it", /moderator fee share didn't match .*seated moderation charter/i],
    ['40307 by labelled code', isPermanentProtocol14Error, 'rejected: code=40307', /report this/i],
    ['41200 ContractModeratedDocumentTypeNotYetUsableError', isModerationNotYetSeatedError,
      'Documents of type post on contract 8Xv3 can not be used until a moderation team is seated', /elects its moderation team/i],
  ]

  it.each(cases)('%s is recognised, permanent and given its own message', (_label, matcher, message, expected) => {
    const error = new Error(message)
    expect(matcher(error)).toBe(true)
    expect(isPermanentProtocol14Error(error)).toBe(true)
    expect(categorizeError(error)).toMatch(expected)
  })

  it('never tells a 40139 to reload: it is a share mismatch, not a stale client', () => {
    const error = new Error('Document create of type post declares a moderators fee of 80000000 credits; the transition agreed to 0, which is not discounted: the contract has no seated moderation charter')
    expect(isModeratorsShareMismatchError(error)).toBe(true)
    expect(categorizeError(error)).not.toMatch(/reload/i)
  })

  it('does not read an unmet reference requirement as a dead target', () => {
    // Both phrasings say "referenced ... for path"; only 40120 means the target is gone,
    // and tombstone repair drops the reference it names.
    const requirement = new Error("referenced contract 8Xv3 for path storeContractId does not meet the reference's requirement moderation elected")
    expect(isReferenceNotFoundError(requirement)).toBe(false)
    expect(isReferenceNotFoundError(new Error('referenced identity 9t2e not found for path followingId'))).toBe(true)
  })

  it.each([
    ['NOT_MODERATOR', 'Identity 9t2e is not the owner or a moderator of contract 8Xv3'],
    ['NOT_MODERATOR', 'Identity 9t2e is not a recipient of the moderators fee pot of contract 8Xv3 and can not claim it'],
    ['NOT_WARNED', 'Identity 9t2e carries no warning on contract 8Xv3'],
    ['WARNING_LIMIT', 'Identity 9t2e already carries 16 warnings on contract 8Xv3, the most it may at a time; clear them before warning it again'],
    ['NO_REMOVAL_RECORD', "Contract 8Xv3 keeps no record of a moderator's deletion of post document D1: there is nothing to restore"],
    ['RESTORE_WINDOW_ELAPSED', 'Document D1 on contract 8Xv3 was removed at 1 and could be restored by moderators for 604800000 milliseconds after that, which block time 999999999999 is past'],
    ['RESTORE_HASH_MISMATCH', 'The document brought back for D1 on contract 8Xv3 hashes to abcd, not to the ef01 its removal record holds'],
    ['ALREADY_RESTORED', 'Document D1 on contract 8Xv3 was already restored by 9t2e at 1790000000000: it is live'],
    ['UNIQUE_VALUE_TAKEN', 'Document D1 has duplicate unique properties ["handle"] with other documents'],
    ['NOT_YET_SEATED', 'Documents of type post on contract 8Xv3 can not be used until a moderation team is seated'],
    ['ABILITY_NOT_GRANTED', 'The elected moderation declaration of contract 8Xv3 does not give its seated team the warn ability on document type post'],
    ['ADDED_MODERATOR_LIMIT', 'Elected charter E1 already has the 3 added moderators contract 8Xv3 allows'],
    ['REASON_NOT_LISTED', 'The moderation of contract 8Xv3 names no reason document, which the proposal S1 of its seated team does not list'],
    ['INVALID_REASON_DOCUMENTS', 'The documents a contract moderation reason cites are invalid: more than 16'],
    ['CHARTER_INVALID', 'The rules of the moderation charter is malformed: empty'],
    ['CHARTER_INVALID', "The moderation charter's reward split of 50% to the leader, 30% equally and 30% by action count sums to 110%, it must sum to 100%"],
    ['CONTEST_NOT_JOINABLE', 'Document Contest for vote_poll V1 is not joinable ContestInfo, it started 1 and it is now 2, and you can only join for 3'],
    ['NOT_MODERATOR', '{"code":41101}'],
    ['RESTORE_HASH_MISMATCH', 'consensus error code=41121'],
  ])('classifies a moderation refusal as %s', (kind, message) => {
    expect(classifyModerationError(new Error(message))).toBe(kind)
  })

  it.each([
    'broadcast timed out at 1741120000000',
    'insufficient balance: 41201000 credits required',
    'no available addresses',
  ])('classifies %s as no moderation refusal', (message) => {
    expect(classifyModerationError(new Error(message))).toBeNull()
    expect(isPermanentProtocol14Error(new Error(message))).toBe(false)
  })
})
