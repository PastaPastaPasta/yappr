/**
 * `isImmutablePropertyChangedError` decides two things that matter: whether the
 * user is told the failure is permanent, and whether `retryPostCreation`
 * bothers retrying. Both a miss and a false positive are harmful, so the
 * matcher is pinned against Drive's real phrasing AND against the strings it
 * must NOT claim.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  brokenPropertyRule,
  CREATE_NOT_RECORDED_ERROR,
  isConsensusRefusal,
  categorizeError,
  classifyModerationError,
  isUnverifiedOutcomeError,
  consensusCodeOf,
  messageWithConsensusCode,
  isActionFeeAgreementError,
  isAlreadyExistsError,
  isContestNotJoinableError,
  isNonFatalWaitError,
  isDeleteConstraintError,
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
  isIdentityNonceConflictError,
  isImmutablePropertyChangedError,
  isInvalidDocumentIdError,
  isModerationBarredError,
  isOncePerIdentityAlreadyClaimedError,
  isPermanentProtocol14Error,
  isPropertyAgreementError,
  isReferencedTypeNotDeletableError,
  isWriteGateError,
  contestFundNeededFromError,
  isContestFullError,
  isContestFundError,
  isFrozenBalanceError,
  isInsufficientTokenError,
  isTokenPausedError,
  isContestedDocumentsNotYetAllowedError,
  isDocumentExpiredError,
  isTimeoutError,
  isRateLimitedError,
  isTrailingBytesError,
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

  it('recognises the 4.2.0-beta.7 phrasing, which names the rule "where"', () => {
    // rs-dpp v4.2.0-beta.7 referenced_document_property_mismatch_error.rs.
    const value = VALUE_MISMATCH.replace('(propertyAgreement on', '(where on')
    const gate = WRITER_GATE.replace('(propertyAgreement on', '(where on')
    expect(value).toContain('(where on orderId)')
    expect(isPropertyAgreementError(new Error(value))).toBe(true)
    expect(isWriteGateError(new Error(value))).toBe(false)
    expect(isWriteGateError(new Error(gate))).toBe(true)
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
// live social contract. Each message is quoted from its `#[error(...)]` format in
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
    // v9 prices post/reply/like optionally, so credits are a real alternative.
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
    const v9 = await import('./error-utils')
    expect(v9.categorizeError(shortOfYapp)).toMatch(/credits/i)
    // v2's costs are required: naming credits there would be advice that cannot work.
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v2')
    const v2 = await import('./error-utils')
    expect(v2.categorizeError(shortOfYapp)).not.toMatch(/credits/i)
    expect(v2.categorizeError(shortOfYapp)).toMatch(/enough YAPP/i)
    expect(v2.categorizeError(shortOfYapp)).toMatch(/buy more/i)
    expect(v9.categorizeError(shortOfYapp)).toMatch(/buy more/i)
    // v10's YAPP is locked: it cannot be bought, so credits are the only way out.
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const v10 = await import('./error-utils')
    expect(v10.categorizeError(shortOfYapp)).toMatch(/credits/i)
    expect(v10.categorizeError(shortOfYapp)).not.toMatch(/buy/i)
  })

  describe('40711 TokenIsPausedError (a paused token paying a tokenCost, beta.3)', () => {
    // rs-dpp token_is_paused_error.rs: #[error("Token {} is paused.", token_id)]
    const paused = [
      'Token AwyQ4ZyWbx3Lr7Zx8K9vvBsF9dtePxP4Xj2u6pJ7sZ8E is paused.',
      'TokenIsPausedError: Token AwyQ is paused.',
      'state transition rejected, code=40711',
      'Consensus error code: 40711',
    ]

    it.each(paused)('recognises %s', (message) => {
      expect(isTokenPausedError(new Error(message))).toBe(true)
      expect(isPermanentProtocol14Error(new Error(message))).toBe(true)
    })

    it('names the way out each cut offers, with no error code and no "buy" or "frozen" advice', async () => {
      const copies: Record<string, string> = {
        // Paused for good: every write already plans credits.
        v13: 'YAPP can\'t be spent right now. Try again to pay with credits instead.',
        // The owner paused it; the cost is optional, so credits are a setting away.
        v9: 'YAPP payments are paused right now. Switch to paying in credits in Settings.',
        // The owner paused it; the cost is required, so there is no other way.
        v2: 'YAPP payments are paused right now, so this can\'t go through. Try again later.',
      }
      for (const [topology, expected] of Object.entries(copies)) {
        vi.resetModules()
        vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
        const scoped = await import('./error-utils')
        for (const message of paused) {
          const copy = scoped.categorizeError(new Error(message))
          expect(copy, topology).toBe(expected)
          expect(copy).not.toMatch(/40711|buy|frozen/i)
        }
      }
    })

    it.each([
      // A paused STORE is a storefront status, not a token.
      'Store is paused and cannot take orders',
      'Identity 9t2e account is frozen for token AwyQ. Action attempted: Document create token payment',
      'Identity 9t2e does not have enough token balance, code=40700',
      'state transition rejected, code=40712',
    ])('does not claim %s', (message) => {
      expect(isTokenPausedError(new Error(message))).toBe(false)
    })
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
      'Document type "follow" property "followingId" must differ from "$ownerId", but the two values are equal', /can't do this to yourself/i],
    ['10421 DocumentPropertyMaxBytesExceededError', isPropertyMaxBytesError,
      'Property content is 2140 bytes in UTF-8, over its maxBytes of 2000', /shorten it/i],
    ['10422 DocumentPropertyConstraintViolatedError', isDocumentPropertyRuleError,
      'A document of type "listing" breaks its propertyConstraints rule "minPrice <= maxPrice": 30 > 20', /combination of values/i],
    ['40135 ReferencedContractRequirementNotMetError', isReferenceRequirementError,
      "referenced contract 8Xv3 for path storeContractId does not meet the reference's requirement moderation elected", /report this/i],
    ['40136 ReferencedIdentityKeyRequirementNotMetError', isReferenceRequirementError,
      'referenced public key 3 of identity 9t2e for dm.recipientKeyId has purpose AUTHENTICATION, the reference requires ENCRYPTION', /report this/i],
    ['40137 ReferencedDocumentLookupInvalidError', isReferenceRequirementError,
      'invalid refersTo lookup through index byName declared at storeName: the index is not unique', /report this/i],
    ['40138 ReferencedDocumentListInvalidError', isReferenceRequirementError,
      'invalid refersTo listElement into inList tags declared at tag: not a list', /report this/i],
    // The 4.2.0-beta.7 phrasings, transcribed from rs-dpp at tag v4.2.0-beta.7.
    ['40137 ReferencedDocumentLookupInvalidError (beta.7)', isReferenceRequirementError,
      'invalid refersTo findBy ($ownerId) declared at privateFeedGrant.$ownerId: no unique index of privateFeedState is over exactly these properties', /report this/i],
    ['40138 ReferencedDocumentListInvalidError (beta.7)', isReferenceRequirementError,
      'invalid refersTo inList tags declared at storeItem.tag: not a list', /report this/i],
    ['40139 DocumentActionFeeModeratorsShareMismatchError', isActionFeeAgreementError,
      "Document create of type post declares a moderators fee of 80000000 credits; the transition agreed to 40000000, which is not the seated moderation charter's 60% share of it", /moderator fee share didn't match .*seated moderation charter/i],
    ['40307 by labelled code', isPermanentProtocol14Error, 'rejected: code=40307', /report this/i],
    ['41200 ContractModeratedDocumentTypeNotYetUsableError', isModerationNotYetSeatedError,
      'Documents of type post on contract 8Xv3 can not be used until a moderation team is seated', /opens when Yappr's first moderators are elected/i],
  ]

  it.each(cases)('%s is recognised, permanent and given its own message', (_label, matcher, message, expected) => {
    const error = new Error(message)
    expect(matcher(error)).toBe(true)
    expect(isPermanentProtocol14Error(error)).toBe(true)
    expect(categorizeError(error)).toMatch(expected)
  })

  it('words a propertyConstraints refusal (10422) as neither self-directed nor free', () => {
    for (const message of [
      'A document of type "listing" breaks its propertyConstraints rule "minPrice <= maxPrice": 30 > 20',
      'rejected: code=10422',
    ]) {
      const copy = categorizeError(new Error(message))
      expect(copy).not.toMatch(/yourself/i)
      expect(copy).not.toMatch(/nothing was charged/i)
    }
    expect(categorizeError(new Error('rejected: code=10419'))).toMatch(/yourself/i)
  })

  it('words a deleteConstraints refusal (40147) as final and not free', () => {
    // Transcribed from rs-dpp's `#[error(...)]` at tag v5.0.0-beta.3.
    for (const message of [
      'Document 8Xv3 of type "poll" can not be deleted: it breaks its deleteConstraints rule "noVotes": it does not hold',
      'rejected: code=40147',
    ]) {
      const error = new Error(message)
      expect(isDeleteConstraintError(error)).toBe(true)
      expect(isPermanentProtocol14Error(error)).toBe(true)
      // Not a propertyConstraints refusal, and no rule name for propertyRuleCopy.
      expect(isDocumentPropertyRuleError(error)).toBe(false)
      expect(brokenPropertyRule(error)).toBeNull()
      const copy = categorizeError(error)
      expect(copy).toMatch(/can't be deleted anymore/i)
      expect(copy).not.toMatch(/nothing was charged/i)
    }
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
    // 4.2.0-beta.7's 40142 says the same of a referenced DOCUMENT.
    const documentRequirement = new Error("referenced document 8Xv3 for path offer.commitmentId does not meet the reference's requirement minimumAgeBlocks 10")
    expect(isReferenceNotFoundError(documentRequirement)).toBe(false)
    expect(isReferenceNotFoundError(new Error('referenced identity 9t2e not found for path followingId'))).toBe(true)
  })

  it('treats a 40142 (a revealed commitment too young, beta.7) as transient, not a defect', () => {
    // rs-dpp v4.2.0-beta.7 referenced_document_requirement_not_met_error.rs; only minimumAgeBlocks raises it.
    for (const error of [
      new Error("referenced document 8Xv3 for path offer.commitmentId does not meet the reference's requirement minimumAgeBlocks 10"),
      { code: 40142, message: 'Failed to broadcast: Protocol error: consensus refusal' },
    ]) {
      expect(isReferenceNotFoundError(error)).toBe(false)
      expect(isReferenceRequirementError(error)).toBe(false)
      expect(isPermanentProtocol14Error(error)).toBe(false)
      expect(categorizeError(error)).toMatch(/only just published/i)
    }
  })

  it.each([
    ['quotedPostId', 'post', /post was removed by the moderators/],
    ['postId', 'post', /post was removed by the moderators/],
    ['rootPostId', 'post', /post was removed by the moderators/],
    ['replyToReplyId', 'reply', /reply was removed by the moderators/],
    ['blogPostId', 'blogPost', /no longer exists/],
  ])('names the removed document for a 40120 on %s, not a missing account (QA D-20)', async (path, documentType, message) => {
    // Pinned to v9, where only moderators remove posts and replies; the message
    // depends on the topology, and earlier tests leave other topologies stubbed.
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9')
    const v9 = await import('./error-utils')
    const error = new Error(`referenced deletable document (own contract, document type ${documentType}) 9BN7B3vnAAAA not found for path ${path}`)
    expect(v9.isReferenceNotFoundError(error)).toBe(true)
    expect(v9.categorizeError(error)).toMatch(message)
    expect(v9.categorizeError(error)).not.toMatch(/account/)
  })

  it('says a 40120 post or reply was deleted, not removed by the moderators, where authors delete too (v10)', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
    const v10 = await import('./error-utils')
    for (const documentType of ['post', 'reply']) {
      const error = new Error(`referenced deletable document (own contract, document type ${documentType}) 9BN7B3vnAAAA not found for path postId`)
      expect(v10.categorizeError(error)).toMatch(new RegExp(`${documentType} was deleted`))
      expect(v10.categorizeError(error)).not.toMatch(/moderators|account/)
    }
  })

  it('keeps the account message for an identity reference', () => {
    expect(categorizeError(new Error('referenced identity 9t2e not found for path followingId'))).toMatch(/account no longer exists/)
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

describe('4.2.0-beta.7 moderator field-change rejections', () => {
  // Messages transcribed from the rs-dpp `#[error(...)]` formats at tag v4.2.0-beta.7 (50d12037).
  it.each([
    ['FIELD_NOT_CHANGEABLE', 'Field note of documents of type report on contract 8Xv3 can not be changed by moderators'],
    ['MODERATOR_FIELD', 'Only the moderators of contract 8Xv3 write field status of documents of type report, and 9t2e does not moderate it (document D1)'],
    ['NOTHING_TO_CHANGE', "The fields a moderator's document change sets are invalid: every field already holds the value the change names, so nothing would change"],
    ['FIELD_NOT_CHANGEABLE', 'consensus error code=41123'],
    ['MODERATOR_FIELD', '{"code":41124}'],
    ['NOTHING_TO_CHANGE', 'refused (code=10905)'],
  ])('classifies a moderator field-change refusal as %s', (kind, message) => {
    expect(classifyModerationError(new Error(message))).toBe(kind)
  })

  it('does not read the new codes inside ids or amounts', () => {
    expect(classifyModerationError(new Error('insufficient balance: 41123000 credits'))).toBeNull()
    expect(classifyModerationError(new Error('document 8Xv109051 not found'))).toBeNull()
  })
})

describe('5.0.0-beta.1 settled-deletion rejections', () => {
  // Messages transcribed from the rs-dpp `#[error(...)]` formats at tag v5.0.0-beta.1.
  it.each([
    ['DELETE_WINDOW_ELAPSED', 'Document D1 on contract 8Xv3 was last modified at 1759100000000 and could be deleted by moderators for 604800 seconds after that, which block time 1759800000000 is past'],
    ['NOT_SETTLED_DELETABLE', 'Document type report of contract 8Xv3 does not let the moderators delete a settled document: it sets no moderatorAbilities.deleteSettled'],
    ['TEAM_NOT_SEATED', 'Contract 8Xv3 has no seated moderation team, and only the members of one approve the deletion of a settled document'],
    ['NOT_SETTLED', 'Document D1 on contract 8Xv3 was last modified at 1759100000000 and moderators delete it alone for 604800 seconds after that, which block time 1759200000000 is within: it is not settled'],
    ['TEAM_ACTION_NOT_FOUND', 'No team action A1 was proposed on contract 8Xv3'],
    ['TEAM_ACTION_ALREADY_SIGNED', 'Moderator 9t2e already approved team action A1 on contract 8Xv3'],
    ['SETTLED_DELETION_NOT_RESTORABLE', 'Document D1 on contract 8Xv3 was deleted at 1759800000000 by the approvals of the seated moderation team, and a deletion the team agreed on is not restored'],
    ['TEAM_ACTION_COMPLETED', 'Team action A1 on contract 8Xv3 already ran'],
    ['TEAM_ACTION_DOCUMENT_CHANGED', 'Document D1 changed since team action A1 on contract 8Xv3 proposed its deletion'],
    ['TEAM_MEMBER_ADDED_AFTER_DOCUMENT', 'Member 9t2e of the moderation team of contract 8Xv3 was added at 1759800000000, not before document D1 was created at 1759700000000, so it can not approve the document\'s deletion'],
    ['NOT_SETTLED_DELETABLE', 'consensus error code=41204'],
    ['TEAM_NOT_SEATED', '{"code":41205}'],
    ['NOT_SETTLED', 'refused (code=41206)'],
    ['TEAM_ACTION_NOT_FOUND', 'refused (code=41207)'],
    ['TEAM_ACTION_ALREADY_SIGNED', 'refused (code=41208)'],
    ['SETTLED_DELETION_NOT_RESTORABLE', 'refused (code=41209)'],
    ['TEAM_ACTION_COMPLETED', 'refused (code=41210)'],
    ['TEAM_ACTION_DOCUMENT_CHANGED', 'refused (code=41211)'],
    ['TEAM_MEMBER_ADDED_AFTER_DOCUMENT', 'refused (code=41212)'],
    ['ALREADY_BANNED', 'Identity 9t2e is already banned on contract 8Xv3'],
    ['NOT_BANNED', 'Identity 9t2e is not banned on contract 8Xv3'],
    ['NOT_SUSPENDED', 'Identity 9t2e is not suspended on contract 8Xv3'],
    ['SUSPENSION_NOT_IN_FUTURE', 'Suspension of identity 9t2e on contract 8Xv3 ends at 1790888796682 which is not after the block time 1790888855419'],
    ['TARGET_NOT_FOUND', 'Identity 9t2e moderated on contract 8Xv3 does not exist'],
    ['SELF_TARGET', 'Identity 9t2e can not moderate itself'],
    ['REASON_TOO_LONG', 'The text of a contract moderation reason is 1200 bytes long, the maximum is 1024'],
    ['ALREADY_BANNED', 'refused (code=41103)'],
    ['NOT_BANNED', '{"code":41104}'],
    ['SELF_TARGET', 'refused (code=10901)'],
  ])('classifies a settled-deletion refusal as %s', (kind, message) => {
    expect(classifyModerationError(new Error(message))).toBe(kind)
  })

  it('does not read the new codes inside ids or amounts', () => {
    expect(classifyModerationError(new Error('insufficient balance: 41208000 credits'))).toBeNull()
    expect(classifyModerationError(new Error('document 8Xv141211 not found'))).toBeNull()
  })
})

describe('4.2.0-beta.5 rejections', () => {
  // Messages transcribed from the rs-dpp `#[error(...)]` formats at tag v4.2.0-beta.5
  // (5c79d12d). Most reach JS as prose with code = -1, so each is matched by its words.
  const EXPIRED = 'Document 8NAdmqQnFw2zcMUe1oWbGnUbA8Q6rj3n3EWtQ5B4Qz1F of type "savedAddress" on contract FE6sjAHVyfzQrz9pcEBgbj5wHgEPLLfLuWWnYufuTGFr expired at 1790294008769, its $createdAt plus the type\'s time to live, which block time 1790294010000 is not before'
  const NOT_PAID = 'Contest for document 8NAdmqQnFw2zcMUe1oWbGnUbA8Q6rj3n3EWtQ5B4Qz1F was not paid for, needs payment of 20000000000 Credits'
  const FULL = 'The vote poll ContestedDocumentResourceVotePoll { contract_id: GWRS, document_type_name: domain, index_name: parentNameAndLabel } already has 1000 contenders, the most a contest accepts'
  const TRAILING = 'Parsing of serialized object failed due to: unable to deserialize dpp::state_transition::StateTransition: 1 bytes left over after the value'
  const NOT_BEFORE_EPOCH = 'Contested documents are not allowed until epoch 4. Current epoch is 0'

  const cases: Array<[string, (error: unknown) => boolean, string, RegExp]> = [
    ['40140 DocumentExpiredError', isDocumentExpiredError, EXPIRED, /expired and can no longer be changed/i],
    ['40140 by labelled code', isDocumentExpiredError, 'consensus error code=40140', /expired/i],
    ['40114 DocumentContestNotPaidForError', isContestFundError, NOT_PAID, /costs more than was offered/i],
    ['40114 by labelled code', isContestFundError, '{"code":40114}', /costs more/i],
    ['40141 DocumentContestMaximumContendersReachedError', isContestFullError, FULL, /closed to new entries/i],
    ['10002 SerializedObjectParsingError for trailing bytes', isTrailingBytesError, TRAILING, /report this/i],
    ['10418 from a node that predates beta.5', isContestedDocumentsNotYetAllowedError, NOT_BEFORE_EPOCH, /contested names yet/i],
  ]

  it.each(cases)('%s is recognised, permanent and given its own message', (_label, matcher, message, expected) => {
    const error = new Error(message)
    expect(matcher(error)).toBe(true)
    expect(isPermanentProtocol14Error(error)).toBe(true)
    expect(categorizeError(error)).toMatch(expected)
  })

  it('never reads an expired document or key as a gateway timeout that may have landed', () => {
    expect(isTimeoutError(new Error(EXPIRED))).toBe(false)
    expect(isTimeoutError(new Error('Identity public key 2 expired at 1790000000000 ms and can no longer sign (block time 1790000000001 ms)'))).toBe(false)
    expect(isTimeoutError(new Error('Identity public key 2 is expired at the block time: it expires at 1 ms and the block time is 2 ms'))).toBe(false)
    // The gateway phrasings still count.
    expect(isTimeoutError(new Error('deadline expired before operation could complete'))).toBe(true)
    expect(isTimeoutError(new Error('wait_for_state_transition_result timed out'))).toBe(true)
  })

  it('tells a full contest from an underpaid one, and reads the fund a 40114 names', () => {
    expect(isContestFullError(new Error(NOT_PAID))).toBe(false)
    expect(isContestFundError(new Error(FULL))).toBe(true)
    expect(contestFundNeededFromError(new Error(NOT_PAID))).toBe(BigInt(20_000_000_000))
    expect(contestFundNeededFromError(new Error(FULL))).toBeNull()
  })

  it.each([
    // An ordinary document that merely says "expired" in a timestamp-free way is not 40140.
    'broadcast deadline expired',
    // Five-digit codes inside amounts and timestamps are never a match on their own.
    'insufficient balance: 40140000 credits required',
    'block time 1790294010002 reached',
    'Parsing of serialized object failed due to: invalid enum variant',
  ])('does not claim %s', (message) => {
    const error = new Error(message)
    expect(isDocumentExpiredError(error)).toBe(false)
    expect(isContestFundError(error)).toBe(false)
    expect(isTrailingBytesError(error)).toBe(false)
    expect(isContestedDocumentsNotYetAllowedError(error)).toBe(false)
  })
})

describe('the strict wait refusing an affected-state proof', () => {
  // rs-sdk v4.2.0-beta.7 broadcast.rs. Since #5136 documents.create/delete no
  // longer raise it for indexOnly types; a hand-built strict wait still can.
  const SNAPSHOT = '[WASM] received a verified VerifiedDocuments snapshot for this transition family; wait with the affected-state APIs instead (wait_for_affected_state in Rust, waitForAffectedState or broadcastAndWaitForAffectedState in JavaScript) and treat the result as a height-pinned snapshot'

  it('is never read as a timeout, so no caller assumes the write landed', () => {
    expect(isTimeoutError(new Error(SNAPSHOT))).toBe(false)
    expect(isAlreadyExistsError(new Error(SNAPSHOT))).toBe(false)
  })
})

describe('4.2.0-beta.6: consensus errors reach JS with their numeric code (platform#5112)', () => {
  /**
   * The shape wasm-sdk 4.2.0-beta.6 throws: a `WasmSdkError` (not an `Error`
   * subclass) whose `code` getter holds the consensus code, or -1. Its message
   * is the Drive prose, possibly behind an operation prefix
   * ("Failed to broadcast: Protocol error: ...", `WasmSdkError::with_context`).
   */
  function sdkError(code: number, message: string): { kind: number; code: number; message: string; name: string; isRetriable: boolean } {
    return { kind: 0, code, message, name: 'Protocol', isRetriable: false }
  }

  it('reads the code from the error, a wrapped error or a cause, and nothing else', () => {
    expect(consensusCodeOf(sdkError(10422, 'x'))).toBe(10422)
    expect(consensusCodeOf({ error: sdkError(40132, 'x') })).toBe(40132)
    expect(consensusCodeOf(new Error('write failed', { cause: sdkError(41107, 'x') }))).toBe(41107)
    // -1 is "not a consensus error"; gRPC statuses and DOMException codes are small.
    expect(consensusCodeOf(sdkError(-1, 'x'))).toBeNull()
    expect(consensusCodeOf({ code: 14, message: 'unavailable' })).toBeNull()
    // Node system errors carry a string code.
    expect(consensusCodeOf({ code: 'ECONNRESET' })).toBeNull()
    expect(consensusCodeOf(new Error('code=40128'))).toBeNull()
    expect(consensusCodeOf('code=40128')).toBeNull()
    expect(consensusCodeOf(null)).toBeNull()
  })

  it('survives a freed wasm error whose getter throws', () => {
    const freed = Object.defineProperty({ message: 'x' }, 'code', { get: () => { throw new Error('null pointer passed to rust') } })
    expect(consensusCodeOf(freed)).toBeNull()
  })

  // Each matcher, reached by the numeric code alone behind prose it does not
  // recognise: what a future Drive rewording, or an operation prefix, looks like.
  const OPAQUE = 'Failed to broadcast: Protocol error: consensus refusal'
  const byCode: Array<[number, (error: unknown) => boolean]> = [
    [10405, isInvalidDocumentIdError],
    [41107, isBarredFromContractError],
    [41114, isModerationBarredError],
    [40129, isGasPayerError],
    [40222, isGasSponsorShortError],
    [40132, isActionFeeAgreementError],
    [40134, isFeeMultiplierNotToleratedError],
    [40139, isModeratorsShareMismatchError],
    [40131, isReferencedTypeNotDeletableError],
    [40722, isOncePerIdentityAlreadyClaimedError],
    [10421, isPropertyMaxBytesError],
    [10422, isDocumentPropertyRuleError],
    [40147, isDeleteConstraintError],
    [40135, isReferenceRequirementError],
    [41200, isModerationNotYetSeatedError],
    [40140, isDocumentExpiredError],
    [40114, isContestFundError],
    [40141, isContestFullError],
    [10418, isContestedDocumentsNotYetAllowedError],
    [40120, isReferenceNotFoundError],
    [40127, isPropertyAgreementError],
    [40128, isImmutablePropertyChangedError],
    [40700, isInsufficientTokenError],
    [40702, isFrozenBalanceError],
  ]

  it.each(byCode)('%i is recognised by its numeric code', (code, matcher) => {
    expect(matcher(sdkError(code, OPAQUE))).toBe(true)
    // The same prose without the code is not claimed: the number did the work.
    expect(matcher(sdkError(-1, OPAQUE))).toBe(false)
  })

  it('classifies a moderation refusal by its numeric code', () => {
    expect(classifyModerationError(sdkError(41116, OPAQUE))).toBe('DELETE_WINDOW_ELAPSED')
    expect(classifyModerationError(sdkError(-1, OPAQUE))).toBeNull()
  })

  it('gives a numeric-code refusal the same message as its prose, and keeps it out of isTimeoutError', () => {
    const expired = sdkError(40140, 'Failed to broadcast: Protocol error: document expired')
    expect(isTimeoutError(expired)).toBe(false)
    expect(isPermanentProtocol14Error(expired)).toBe(true)
    expect(categorizeError(expired)).toMatch(/expired and can no longer be changed/i)
    expect(categorizeError(sdkError(10422, OPAQUE))).toMatch(/combination of values/i)
    expect(categorizeError(sdkError(41107, OPAQUE))).toMatch(/banned or suspended/i)
  })

  it('still matches the prose an older node renders with code -1 (testnet runs pre-beta.6 nodes)', () => {
    const prose = 'A document of type "listing" breaks its propertyConstraints rule "minPrice <= maxPrice": 30 > 20'
    expect(isDocumentPropertyRuleError(sdkError(-1, prose))).toBe(true)
    expect(isDocumentPropertyRuleError(new Error(prose))).toBe(true)
    expect(categorizeError(sdkError(-1, prose))).toMatch(/combination of values/i)
  })

  it('reads a write gate from the prose, whichever way the 40127 arrived', () => {
    expect(isWriteGateError(sdkError(40127, WRITER_GATE))).toBe(true)
    expect(isWriteGateError(sdkError(-1, WRITER_GATE))).toBe(true)
    expect(isWriteGateError(sdkError(40127, VALUE_MISMATCH))).toBe(false)
  })

  it('never reads a broadcast error\'s generic 1 or 20000 as one of the consensus codes it matches', () => {
    // 1 is ConsensusError::DefaultError and 20000 IdentityNotFoundError: neither is
    // in any matcher's set, and 1 is below the five-digit consensus range.
    expect(consensusCodeOf(sdkError(1, OPAQUE))).toBeNull()
    for (const code of [1, 20000]) {
      const error = sdkError(code, OPAQUE)
      for (const [, matcher] of byCode) expect(matcher(error)).toBe(false)
      expect(isPermanentProtocol14Error(error)).toBe(false)
      expect(classifyModerationError(error)).toBeNull()
      expect(categorizeError(error)).toBe(`Failed to create post: ${OPAQUE}`)
    }
  })

  it('does not let one numeric code claim a neighbour', () => {
    const banned = sdkError(41107, OPAQUE)
    expect(isGasPayerError(banned)).toBe(false)
    expect(isDocumentExpiredError(banned)).toBe(false)
    expect(isImmutablePropertyChangedError(sdkError(40127, OPAQUE))).toBe(false)
    expect(isPropertyAgreementError(sdkError(40128, OPAQUE))).toBe(false)
  })
})

describe('every consensus code against every matcher', () => {
  const sdkError = (code: number) => ({ code, message: 'Failed to broadcast: Protocol error: consensus refusal', name: 'Protocol', isRetriable: false })

  const matchers: Record<string, (error: unknown) => boolean> = {
    isTimeoutError, isAlreadyExistsError, isNonFatalWaitError,
    isInsufficientTokenError, isFrozenBalanceError, isReferenceNotFoundError, isPropertyAgreementError,
    isWriteGateError, isImmutablePropertyChangedError, isInvalidDocumentIdError, isModerationBarredError,
    isBarredFromContractError, isGasPayerError, isActionFeeAgreementError, isModeratorsShareMismatchError,
    isFeeMultiplierNotToleratedError, isGasSponsorShortError, isReferencedTypeNotDeletableError,
    isOncePerIdentityAlreadyClaimedError, isPropertyMaxBytesError, isDocumentPropertyRuleError, isDeleteConstraintError,
    isReferenceRequirementError, isModerationNotYetSeatedError, isDocumentExpiredError, isContestFundError,
    isContestNotJoinableError, isContestFullError, isTrailingBytesError, isContestedDocumentsNotYetAllowedError,
  }

  // The matchers each code may claim. The only overlaps are supersets by design:
  // isModerationBarredError ⊃ 41107/41108, isGasPayerError ⊃ 40222,
  // isActionFeeAgreementError ⊃ 40134/40139, isContestFundError ⊃ 40141.
  const intended: Record<number, string[]> = {
    10405: ['isInvalidDocumentIdError'],
    41107: ['isBarredFromContractError', 'isModerationBarredError'],
    41108: ['isBarredFromContractError', 'isModerationBarredError'],
    41114: ['isModerationBarredError'],
    40129: ['isGasPayerError'],
    40130: ['isGasPayerError'],
    40222: ['isGasSponsorShortError', 'isGasPayerError'],
    40132: ['isActionFeeAgreementError'],
    40133: ['isActionFeeAgreementError'],
    40134: ['isFeeMultiplierNotToleratedError', 'isActionFeeAgreementError'],
    40139: ['isModeratorsShareMismatchError', 'isActionFeeAgreementError'],
    40131: ['isReferencedTypeNotDeletableError'],
    40722: ['isOncePerIdentityAlreadyClaimedError'],
    10421: ['isPropertyMaxBytesError'],
    10419: ['isDocumentPropertyRuleError'],
    10422: ['isDocumentPropertyRuleError'],
    40147: ['isDeleteConstraintError'],
    40135: ['isReferenceRequirementError'],
    40136: ['isReferenceRequirementError'],
    40137: ['isReferenceRequirementError'],
    40138: ['isReferenceRequirementError'],
    41200: ['isModerationNotYetSeatedError'],
    40140: ['isDocumentExpiredError'],
    40114: ['isContestFundError'],
    40141: ['isContestFullError', 'isContestFundError'],
    40111: ['isContestNotJoinableError'],
    10418: ['isContestedDocumentsNotYetAllowedError'],
    40120: ['isReferenceNotFoundError'],
    40121: ['isReferenceNotFoundError'],
    40122: ['isReferenceNotFoundError'],
    40123: ['isReferenceNotFoundError'],
    40124: ['isReferenceNotFoundError'],
    40125: ['isReferenceNotFoundError'],
    40127: ['isPropertyAgreementError'],
    40128: ['isImmutablePropertyChangedError'],
    40700: ['isInsufficientTokenError'],
    40702: ['isFrozenBalanceError'],
    // Matched only by private helpers or by classifyModerationError, or by nothing:
    // key expiry, vote choice, moderation-only codes, already-present, nonce,
    // generatedFrom, and the generic broadcast codes.
    20016: [], 40219: [], 40307: [], 41101: [], 41111: [], 41112: [], 41123: [], 41124: [], 10905: [],
    41204: [], 41205: [], 41206: [], 41207: [], 41208: [], 41209: [], 41210: [], 41211: [],
    40100: [], 40204: [], 10424: [], 10002: [], 20000: [], 1: [],
  }

  it.each(Object.entries(intended))('code %s claims exactly its matchers', (code, expected) => {
    const error = sdkError(Number(code))
    const claimed = Object.entries(matchers).filter(([, matcher]) => matcher(error)).map(([name]) => name)
    expect(claimed.sort()).toEqual([...expected].sort())
  })

  it('claims the same through the flattened string a write result carries', () => {
    for (const [code, expected] of Object.entries(intended)) {
      const flattened = new Error(messageWithConsensusCode(sdkError(Number(code))))
      const claimed = Object.entries(matchers).filter(([, matcher]) => matcher(flattened)).map(([name]) => name)
      // A code below the consensus range (1) is never labelled; everything else round-trips.
      expect(claimed.sort(), `code ${code}`).toEqual([...expected].sort())
    }
  })
})

describe('messageWithConsensusCode', () => {
  it('labels a numeric consensus code once, and leaves everything else as it was', () => {
    expect(messageWithConsensusCode({ code: 40132, message: 'refused' })).toBe('refused (code=40132)')
    expect(messageWithConsensusCode({ code: 40132, message: 'refused, code=40132' })).toBe('refused, code=40132')
    expect(messageWithConsensusCode({ code: -1, message: 'refused' })).toBe('refused')
    expect(messageWithConsensusCode({ code: 1, message: 'rejected' })).toBe('rejected')
    expect(messageWithConsensusCode(new Error('plain'))).toBe('plain')
  })
})

describe('isRateLimitedError (QA D-54)', () => {
  it('recognises the DAPI gateway throttling a request', () => {
    expect(isRateLimitedError({ message: 'no available addresses to retry, last error: grpc error: code: \'Some resource has been exhausted\', message: "rate limited"' })).toBe(true)
    expect(isRateLimitedError(new Error('transport error: grpc error: code: \'Some resource has been exhausted\', message: "rate limited"'))).toBe(true)
    expect(isRateLimitedError(new Error('RESOURCE_EXHAUSTED'))).toBe(true)
  })

  it('does not claim other failures', () => {
    expect(isRateLimitedError(new Error('fetch failed'))).toBe(false)
    expect(isRateLimitedError(new Error('Insufficient token balance'))).toBe(false)
  })
})

describe('isIdentityNonceConflictError (40204)', () => {
  // rs-dpp `InvalidIdentityNonceError` Display at v4.2.0-beta.5.
  const AT_TIP = 'Identity E2m5VDqxnJ2hyPp8u9MwMjaaCqFLE2Mfq7ScoGpEe5eN is trying to set an invalid identity nonce. The current identity nonce is 133, we are setting 133, error is nonce already present at tip'
  const IN_PAST = 'Identity E2m5VDqxnJ2hyPp8u9MwMjaaCqFLE2Mfq7ScoGpEe5eN is trying to set an invalid identity nonce. The current identity nonce is 137, we are setting 136, error is nonce already present in past'

  it('matches the refusal in every phrasing Drive and the SDK give it', () => {
    expect(isIdentityNonceConflictError(new Error(AT_TIP))).toBe(true)
    expect(isIdentityNonceConflictError(new Error(IN_PAST))).toBe(true)
    expect(isIdentityNonceConflictError(new Error('InvalidIdentityNonceError: nonce too far in future'))).toBe(true)
    expect(isIdentityNonceConflictError({ message: 'state transition broadcast error: {"code":40204}' })).toBe(true)
  })

  it('tells the user to retry rather than buy YAPP', () => {
    expect(categorizeError(new Error(AT_TIP))).toMatch(/not saved\. try again/i)
  })

  it("does not claim createDocument's consumed-but-absent result: what took the nonce is unknown, so it is no clash to retry", () => {
    expect(isIdentityNonceConflictError(new Error(CREATE_NOT_RECORDED_ERROR))).toBe(false)
    expect(isTimeoutError(new Error(CREATE_NOT_RECORDED_ERROR))).toBe(false)
    expect(categorizeError(new Error(CREATE_NOT_RECORDED_ERROR))).toBe(CREATE_NOT_RECORDED_ERROR)
  })

  it('does not claim a timeout, a duplicate document or bare digits', () => {
    expect(isIdentityNonceConflictError(new Error('waitForResponse timed out'))).toBe(false)
    expect(isIdentityNonceConflictError(new Error('Document Duplicate unique properties'))).toBe(false)
    expect(isIdentityNonceConflictError(new Error('balance 1790294020400 too low'))).toBe(false)
  })
})

describe('isConsensusRefusal', () => {
  it('is a verdict: a broadcast refusal, a labelled consensus code or a nonce refusal', () => {
    expect(isConsensusRefusal(new Error('state transition broadcast error: Document X has duplicate unique properties ["tag"] with other documents'))).toBe(true)
    expect(isConsensusRefusal(new Error('Document X has invalid revision Some(2). The desired revision is 2 | code=40106'))).toBe(true)
    expect(isConsensusRefusal(new Error('Identity Y is trying to set an invalid identity nonce. The current identity nonce is 764, we are setting 764, error is nonce already present at tip'))).toBe(true)
  })

  it('is not an unknown outcome: a timeout, a transport failure, an unproven snapshot or bare digits', () => {
    expect(isConsensusRefusal(new Error('waitForResponse timed out after 10s'))).toBe(false)
    expect(isConsensusRefusal(new Error('transport error: rate limited'))).toBe(false)
    expect(isConsensusRefusal(new Error('received a verified VerifiedDocuments snapshot for this transition family'))).toBe(false)
    expect(isConsensusRefusal(new Error('balance 1790294020400 too low'))).toBe(false)
  })
})

describe('isUnverifiedOutcomeError', () => {
  it.each([
    [{ code: -1, name: 'Proof', message: 'context provider error: invalid quorum: Quorum not found in cache for hash: 1855' }],
    [{ code: -1, name: 'DapiClientError', message: 'no available addresses to retry' }],
    [new Error('proof verification failed')],
  ])('reads %o as an answer that could not be verified', (error) => {
    expect(isUnverifiedOutcomeError(error)).toBe(true)
  })

  it.each([
    [{ code: 41116, name: 'Protocol', message: 'Document D1 ... is past' }],
    [new Error('state transition broadcast error: referenced moderated document not found')],
    [new Error('Identity 9t2e is banned on contract 8Xv3 (code=41107)')],
    [new Error('offline')],
  ])('never reads a verdict or an unrelated failure %o as unverified', (error) => {
    expect(isUnverifiedOutcomeError(error)).toBe(false)
  })
})

describe('v13 propertyConstraints rules', () => {
  const broken = (rule: string) => new Error(`A document of type "reply" breaks its propertyConstraints rule "${rule}": not satisfied`)

  it('names the rule a 10422 broke', () => {
    expect(brokenPropertyRule(broken('parentIsRoot'))).toBe('parentIsRoot')
    expect(brokenPropertyRule(new Error('offline'))).toBeNull()
  })

  it.each([
    ['parentIsRoot', /wrong post owner/],
    ['media', /attached media/],
    ['blankTombstone', /emptied completely/],
    ['live', /live marker/],
    ['oneTarget', /exactly one post, reply or profile/],
    ['boxOnContent', /profile report/],
    ['otherNote', /Say what is wrong/],
  ])('explains the v13 rule %s', (rule, copy) => {
    expect(categorizeError(broken(rule))).toMatch(copy)
  })

  it('keeps the generic copy for a rule it does not know, another contract\'s rule, or an inherited key', () => {
    expect(categorizeError(broken('minPrice <= maxPrice'))).toMatch(/combination of values/)
    expect(categorizeError(new Error('A document of type "listing" breaks its propertyConstraints rule "media": no'))).toMatch(/combination of values/)
    expect(categorizeError(broken('constructor'))).toMatch(/combination of values/)
  })
})
