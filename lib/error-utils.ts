/**
 * Utility functions for error handling and message extraction.
 */

const MAX_ERROR_DEPTH = 5

/**
 * Extracts a human-readable error message from various error formats.
 * Handles strings, Error instances, and nested error objects.
 * Uses depth counter to prevent infinite recursion on circular references.
 */
export function extractErrorMessage(error: unknown, depth: number = 0): string {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message

  // Guard against circular references or deeply nested errors
  if (depth >= MAX_ERROR_DEPTH) {
    return 'Unknown error (max depth reached)'
  }

  // Handle nested error objects
  const err = error as Record<string, unknown>
  if (err.message && typeof err.message === 'string') return err.message
  if (err.error) return extractErrorMessage(err.error, depth + 1)
  if (err.cause) return extractErrorMessage(err.cause, depth + 1)

  // Try to stringify, but avoid [object Object]
  try {
    const str = JSON.stringify(error)
    if (str && str !== '{}') return str.slice(0, 200)
  } catch {
    // Ignore stringify errors (including circular reference errors)
  }

  return 'Unknown error'
}

/**
 * Checks if an error is a timeout error that might indicate success.
 * DAPI gateway often times out even when transactions succeed.
 */
export function isTimeoutError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  return (
    msg.includes('timeout') ||
    msg.includes('deadline') ||
    msg.includes('expired') ||
    msg.includes('timed out')
  )
}

/**
 * Checks if an error indicates the state transition already exists
 * (in mempool, in chain, or nonce already used). These errors mean
 * the broadcast likely succeeded even though we didn't get confirmation.
 */
export function isAlreadyExistsError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  return (
    msg.includes('already in mempool') ||
    msg.includes('already in chain') ||
    msg.includes('nonce already present') ||
    msg.includes('already exists')
  )
}

/**
 * Checks if an error from waitForResponse is a non-fatal verification
 * issue that should not fail an operation whose broadcast succeeded.
 * These are typically transient network/propagation issues (e.g. a newly
 * deployed contract not yet visible to the node handling the wait request).
 */
export function isNonFatalWaitError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  // Only match the specific "unknown contract" propagation error.
  // Do NOT broadly match "document verification" or "drive error" —
  // those can indicate permanent rejections (wrong schema, bad signature, etc.).
  return msg.includes('unknown contract')
}

/**
 * Checks if an error indicates the signer lacks enough YAPP tokens to pay a
 * document's tokenCost (post/reply/like/repost). When true, the UI should
 * prompt the user to buy YAPP rather than show a generic failure.
 */
export function isInsufficientTokenError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  return (
    msg.includes('identitydoesnothaveenoughtokenbalance') ||
    msg.includes('not have enough token') ||
    msg.includes('enough token balance') ||
    // Drive phrasing: "Identity X does not have enough balance for token Y:
    // required 10, actual 0, action: Document create token payment"
    msg.includes('enough balance for token') ||
    msg.includes('insufficient token')
  )
}

/**
 * Checks if an error indicates the signer's token account is frozen (suspended
 * by a token authority via a freeze action). Frozen accounts cannot spend YAPP,
 * so token payments fail — but buying more YAPP will NOT help. The UI should
 * explain the account is suspended rather than prompt a purchase.
 *
 * Drive phrasing: "Identity X account is frozen for token Y. Action attempted: Z"
 */
export function isFrozenBalanceError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  // Match the frozen failure but NOT the "is not frozen for token" error that
  // destroyFrozen raises when the target account was never frozen.
  return (
    msg.includes('is frozen for token') ||
    msg.includes('identitytokenaccountfrozen') ||
    msg.includes('account frozen')
  )
}

/**
 * Checks if an error indicates Platform refused a write because something the
 * document points at does not exist (or is not usable as a reference target).
 *
 * This is the `refersTo` family introduced with protocol v14. On the yappr v3
 * contract `follow.followingId` and `postMention.mentionedUserId` declare
 * `refersTo: { type: 'identity' }`, so following or mentioning an identity that
 * is not on chain is rejected by consensus instead of creating a dangling
 * document. The rejection is permanent: retrying cannot make the target appear.
 *
 * Matches both the camel-cased consensus error names and the human phrasings
 * Drive renders, e.g. "referenced identity <id> not found for path followingId"
 * (ReferencedEntityNotFoundError, code 40120). The remaining members of the
 * family — 40121 ReferencedDocumentTypeNotFound, 40122
 * ReferencedDocumentTypeDeletable, 40123 ReferencedIdentityKeyNotFound, 40124
 * ReferencedIdentityKeyDisabled, 40125 ReferencedKeyIdPropertyInvalid — are
 * contract-authoring mistakes rather than user situations, but are matched too
 * so they never fall through to a retry.
 *
 * These strings are dormant on testnet (protocol v13 has no `refersTo`) and will
 * be tightened to whatever `scripts/verify-refersto.mjs` actually observes on
 * devnet. Until then they are pinned to the `#[error(...)]` formats in
 * rs-dpp's `errors/consensus/state/document/referenced_*_error.rs`.
 */
export function isReferenceNotFoundError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  return (
    msg.includes('referencedentitynotfound') ||
    msg.includes('referenceddocumenttypenotfound') ||
    msg.includes('referenceddocumenttypedeletable') ||
    msg.includes('referencedidentitykeynotfound') ||
    msg.includes('referencedidentitykeydisabled') ||
    msg.includes('referencedkeyidpropertyinvalid') ||
    // Every Drive phrasing in this family names the schema path the reference
    // was declared on: "referenced identity <id> not found for path <p>",
    // "referenced document type <t> not found in contract <c> for path <p>",
    // "referenced public key <k> of identity <i> not found/is disabled for path
    // <p>". Requiring "for path " as well as "referenced " keeps this from
    // swallowing the many unrelated "... not found" errors Platform can raise
    // for a missing document, contract or identity.
    (msg.includes('referenced ') && msg.includes(' for path ')) ||
    // ReferencedDocumentTypeDeletableError phrases it differently: "... a
    // permanentDocument reference at path <p> requires a document type with
    // canBeDeleted: false".
    msg.includes('requires a document type with canbedeleted')
  )
}

/**
 * Checks whether Platform refused a write because a `propertyAgreement` pair
 * disagreed with the referenced document (ReferencedDocumentPropertyMismatch,
 * state code 40127).
 *
 * Two shapes reach here and they mean different things to a user:
 *
 * - a VALUE pair — the document repeated a referenced value that has since
 *   changed, or was built from a stale cache. Retrying with fresh data works.
 * - a WRITER GATE, where the referring side is `$ownerId`: the signer is not
 *   the identity the referenced document says may write this. Retrying never
 *   works, so {@link isWriteGateError} splits it out.
 *
 * Both are permanent for the transition as submitted and neither charges the
 * document's token cost.
 *
 * The numeric code is matched on word boundaries (as `isDuplicateVoteError`
 * does for 40105): an unbounded substring would also fire on a document id or a
 * credit amount that happens to contain those five digits.
 */
export function isPropertyAgreementError(error: unknown): boolean {
  return /referenceddocumentpropertymismatch|does not agree with the referenced document|\b40127\b/i
    .test(extractErrorMessage(error))
}

/**
 * Checks whether the 40127 above is a WRITER GATE rather than a value
 * disagreement: the contract declares `propertyAgreement: {"$ownerId": …}` on
 * the reference, so only one identity may write the document at all.
 *
 * Drive names the referring property in the message — "the document's $ownerId
 * does not agree with the referenced document's sellerId (propertyAgreement on
 * orderId)" — and `$ownerId` on the LEFT is what makes it a gate. Yappr uses
 * these for "only the store owner lists items in a store", "only the seller
 * posts order status updates" and "only the buyer reviews their own order".
 */
export function isWriteGateError(error: unknown): boolean {
  // Extracted once and handed back to the broader predicate: a gate is a 40127
  // that ALSO names `$ownerId` as the referring side, and `extractErrorMessage`
  // returns a string it is given unchanged.
  const message = extractErrorMessage(error)
  return isPropertyAgreementError(message) && /the document's \$ownerid does not agree/i.test(message)
}

/**
 * Checks if an error is Platform refusing a REPLACE that touched a property
 * the document type freezes — `DocumentImmutablePropertyChangedError`, state
 * code **40128**, new in protocol v14 / Platform 4.2.0-beta.2.
 *
 * Contract v7 declares `immutable` lists on `post` and `reply` (language, the
 * tag, the quote graph, the embed triple, a reply's parent linkage, and
 * `deleted` as immutable-but-settable). "Touched" covers a changed value, a
 * newly added property AND one the replacement dropped, so the only way to
 * hit this from the app is a tombstone whose preserve set has drifted from
 * the contract — a permanent, code-level rejection that must never be retried
 * or read as a transient failure.
 *
 * Matches the consensus error name and Drive's rendered phrasing, "property
 * '<p>' of document <id> (type '<t>') is immutable and cannot be changed by a
 * replace" (rs-dpp `document_immutable_property_changed_error.rs`), plus the
 * numeric code where the SDK attaches it as a labelled field.
 *
 * The numeric alternative is deliberately anchored to a `code` label rather
 * than matched as a bare substring: "40128" occurs inside ordinary millisecond
 * timestamps and credit amounts, and a false positive here would both mislabel
 * an unrelated failure and stop {@link retryPostCreation} retrying something
 * genuinely transient. The optional quote covers the `JSON.stringify` fallback
 * in {@link extractErrorMessage}, which renders the field as `"code":40128`.
 */
export function isImmutablePropertyChangedError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase()
  return (
    msg.includes('documentimmutablepropertychanged') ||
    /\bcode"?\s*[=:]\s*40128\b/.test(msg) ||
    (msg.includes('is immutable') && msg.includes('replace'))
  )
}

/**
 * Categorizes common Dash Platform errors and returns a user-friendly message.
 */
export function categorizeError(error: unknown): string {
  // Permanent and specific, like the reference family below: no amount of
  // YAPP, retrying or reconnecting changes the outcome.
  if (isImmutablePropertyChangedError(error)) {
    return 'Part of this post can no longer be changed once it has been published.'
  }

  // A reference rejection is permanent and specific: say what is actually wrong
  // rather than offering YAPP or a retry.
  if (isReferenceNotFoundError(error)) {
    return 'That account no longer exists on Dash Platform, so this action can\'t be completed.'
  }

  // Before the generic agreement message: a gate is about WHO is signing, and
  // telling that user to "try again" would be wrong.
  if (isWriteGateError(error)) {
    return 'Only the owner of this store, order or listing can do that.'
  }

  if (isPropertyAgreementError(error)) {
    return 'This is out of date — reload the page and try again.'
  }

  // Check frozen before insufficient-balance: a frozen account can't spend even
  // with a positive balance, and buying more YAPP won't unfreeze it.
  if (isFrozenBalanceError(error)) {
    return 'Your account is suspended (frozen) and can\'t spend YAPP right now. Contact a moderator to be reinstated.'
  }

  if (isInsufficientTokenError(error)) {
    return 'You don\'t have enough YAPP. Buy more to keep posting.'
  }

  const errorMessage = extractErrorMessage(error)

  if (
    errorMessage.includes('no available addresses') ||
    errorMessage.includes('Missing response message')
  ) {
    return 'Dash Platform is temporarily unavailable. Please try again in a few moments.'
  }

  if (
    errorMessage.includes('Network') ||
    errorMessage.includes('connection') ||
    errorMessage.includes('timeout')
  ) {
    return 'Network error. Please check your connection and try again.'
  }

  if (
    errorMessage.includes('Private key not found') ||
    errorMessage.includes('Not logged in')
  ) {
    return 'Your session has expired. Please log in again.'
  }

  return `Failed to create post: ${errorMessage}`
}
