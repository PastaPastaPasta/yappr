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
 * Categorizes common Dash Platform errors and returns a user-friendly message.
 */
export function categorizeError(error: unknown): string {
  // A reference rejection is permanent and specific: say what is actually wrong
  // rather than offering YAPP or a retry.
  if (isReferenceNotFoundError(error)) {
    return 'That account no longer exists on Dash Platform, so this action can\'t be completed.'
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
