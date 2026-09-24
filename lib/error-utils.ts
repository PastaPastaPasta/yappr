/**
 * Utility functions for error handling and message extraction.
 */
import { paymentIsChoosable } from '@/lib/payment-preference'

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
  // A reference whose target EXISTS but misses a declared requirement (40135,
  // "referenced contract <c> for path <p> does not meet ...") shares the
  // "referenced ... for path" phrasing below; it is not a dead target, and
  // treating it as one would have tombstone repair drop a live reference.
  if (isReferenceRequirementError(error)) return false
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
 * The schema path a `ReferencedEntityNotFoundError` (40120) names, or null.
 *
 * Drive builds the message from rs-dpp's `#[error("referenced {entity_type}
 * {entity_id} not found for path {path}")]`, where `path` is a key of the
 * document type's flattened properties — for Yappr's references a top-level
 * property name like `quotedPostId`. A caller that must clear a dead reference
 * needs to know WHICH one died: dropping a reference whose target is still
 * alive is a 40128 instead (the immutable check judges each removed property on
 * its own), so guessing is worse than not retrying.
 */
export function referencedPathFromError(error: unknown): string | null {
  const match = /\bfor path ([A-Za-z0-9_.]+)/.exec(extractErrorMessage(error))
  return match ? match[1] : null
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
 * Matches a labelled consensus code (`code=41107`, `"code":41107`), never the
 * bare digits: five-digit codes occur inside timestamps and credit amounts.
 */
function hasConsensusCode(message: string, codes: readonly number[]): boolean {
  return codes.some((code) => new RegExp(`\\bcode"?\\s*[=:]\\s*${code}\\b`).test(message))
}

/**
 * Checks if Platform refused a create because the document id the client
 * built does not match the one consensus derives — `InvalidDocumentTransitionIdError`,
 * basic code **10405**, made reachable by protocol 14 (Platform 4.2.0-beta.3,
 * platform#4859), where the id commits to the identity contract nonce of the
 * create transition.
 *
 * wasm-dpp2 derives that id for Yappr (`lib/document-id.ts`, beta.4+), so
 * hitting this means the nonce or the entropy on the transition disagree with
 * what was signed, or the SDK and the network run different platform
 * versions — a code-level bug, never a user situation. Permanent: the
 * same transition is refused every time, and a fresh attempt builds a fresh
 * one anyway. Drive's phrasing: "Invalid document transition id <id>, expected <id>".
 */
export function isInvalidDocumentIdError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /invaliddocumenttransitionid/i.test(msg) ||
    /invalid document transition id .* expected/i.test(msg) ||
    hasConsensusCode(msg, [10405])
  )
}

/**
 * Checks if Platform refused a document action because contract moderation
 * bars the signer — new in protocol 14 (platform#4830):
 *
 * - **41107** `ContractUserBannedError` — "Identity X is banned on contract Y
 *   and can not act on its documents";
 * - **41108** `ContractUserSuspendedError` — "... is suspended on contract Y
 *   until T and can not act on its documents";
 * - **41114** `ContractModerationCounterpartyBarredError` — the OTHER party is
 *   barred: "Identity X is banned or suspended on contract Y and can not be the
 *   <role> of a document" (e.g. a transfer or purchase whose recipient is banned).
 *
 * Permanent for the signer (a suspension lifts on its own, but not by
 * retrying), and distinct from a frozen token account: buying YAPP does not
 * help and the message must not suggest it.
 */
export function isModerationBarredError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    isBarredFromContractError(error) ||
    /contractmoderationcounterpartybarred/i.test(msg) ||
    /is banned or suspended on contract .* and can not be the/i.test(msg) ||
    hasConsensusCode(msg, [41114])
  )
}

/**
 * The SIGNER is barred: banned (41107) or suspended (41108) from the contract,
 * as opposed to the counterparty case above. The UI resolves the standing and
 * its recorded reason for exactly these two (`reportBarredWrite`); a refusal
 * is paid and bumps the nonce, so retrying is pointless.
 */
export function isBarredFromContractError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /contractuser(banned|suspended)/i.test(msg) ||
    /is (banned|suspended) (from|on) (this|the )?contract/i.test(msg) ||
    /is (banned|suspended) on contract .* and can not act on its documents/i.test(msg) ||
    hasConsensusCode(msg, [41107, 41108])
  )
}

/**
 * Checks if Platform refused a write over WHO PAYS THE GAS — the contract-owner
 * sponsorship of token-paid document actions, new in protocol 14
 * (platform#4826):
 *
 * - **40129** `GasFeesPaidByNotAllowedError` — the transition asked for a payer
 *   the document type does not offer;
 * - **40130** `InconsistentGasFeesPaidByInBatchError` — one batch, two payers;
 * - **40222** `GasSponsorInsufficientBalanceError` — the sponsoring contract
 *   owner cannot cover the fee right now.
 *
 * The first two are client bugs; the third is a state the user cannot fix and
 * that a retry will not change on its own. All permanent for the transition.
 */
export function isGasPayerError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /gasfeespaidbynotallowed|inconsistentgasfeespaidbyinbatch|gassponsorinsufficientbalance/i.test(msg) ||
    /asks for gas fees paid by .* but the document type only offers/i.test(msg) ||
    /the gas of a batch is paid by one identity/i.test(msg) ||
    /sponsoring the gas has balance .* is required/i.test(msg) ||
    hasConsensusCode(msg, [40129, 40130, 40222])
  )
}

/**
 * Checks if Platform refused a document action over its ACTION FEE agreement —
 * fees a document type charges to the contract owner and moderators, new in
 * protocol 14 (platform#4851, #4858):
 *
 * - **40132** `DocumentActionFeeAgreementNotSetError` — the type charges a fee
 *   and the transition carries no agreement;
 * - **40133** `DocumentActionFeeAgreementMismatchError` — the agreement names
 *   different amounts or pricing than the type declares;
 * - **40134** `DocumentActionFeeMultiplierNotToleratedError` — the network fee
 *   multiplier moved past the tolerance the agreement allowed.
 *
 * Social v8 charges post and reply creates a fee to the moderators pot, so
 * 40132/40133 mean the client and the deployed contract disagree about the
 * amounts — either the contract was re-cut under the client, or the agreement
 * was not attached. Permanent for the transition as built.
 */
export function isActionFeeAgreementError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    isFeeMultiplierNotToleratedError(error) ||
    /documentactionfeeagreementnotset|documentactionfeeagreementmismatch/i.test(msg) ||
    /charges an action fee of .* and the transition carries no action fee agreement/i.test(msg) ||
    /charges an action fee of .* but the transition agreed to/i.test(msg) ||
    isModeratorsShareMismatchError(error) ||
    hasConsensusCode(msg, [40132, 40133])
  )
}

/**
 * **40139** `DocumentActionFeeModeratorsShareMismatchError` (4.2.0-beta.4,
 * platform#4971): on an ELECTED contract the moderators part of an action fee
 * is the seated charter's share of the declared amount, and the agreement named
 * something else — or a discount while no charter is seated. Like 40133, the
 * client priced the agreement from a stale picture of the contract.
 * Message: "Document <action> of type <t> declares a moderators fee of <n>
 * credits; the transition agreed to <m>, which is not ...".
 */
function isModeratorsShareMismatchError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /documentactionfeemoderatorssharemismatch/i.test(msg) ||
    /declares a moderators fee of .* the transition agreed to/i.test(msg) ||
    hasConsensusCode(msg, [40139])
  )
}

/**
 * The 40134 member of the family on its own: the agreement's amounts were
 * right, but the epoch fee multiplier rose past the tolerance the signer
 * allowed. Unlike 40132/40133 this is not a stale client — the write path
 * forgets the multiplier it knew and the NEXT attempt re-reads it.
 */
export function isFeeMultiplierNotToleratedError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /documentactionfeemultipliernottolerated/i.test(msg) ||
    /agreed to an action fee priced with a fee multiplier/i.test(msg) ||
    hasConsensusCode(msg, [40134])
  )
}

/**
 * 40222 on its own: the contract owner the transition PREFERRED as gas
 * sponsor is short of credits. Under `preferContractOwner` (the only offer
 * Yappr asks for) the network falls back to the signer instead of raising
 * this, so seeing it means the signer's own credits could not cover the write
 * either, or the transition insisted (`contractOwner`), which Yappr never does.
 */
export function isGasSponsorShortError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /gassponsorinsufficientbalance/i.test(msg) ||
    /sponsoring the gas has balance .* is required/i.test(msg) ||
    hasConsensusCode(msg, [40222])
  )
}

/**
 * `ReferencedDocumentTypeNotDeletableError`, state code **40131** (protocol 14,
 * platform#4860): a `refersTo: deletableDocument` declaration points at a
 * document type whose documents cannot be deleted. Purely a contract-authoring
 * mistake, matched so it never falls through to a retry; the message is
 * "documents of referenced document type <t> in contract <c> can not be
 * deleted; a deletableDocument reference at path <p> requires ...".
 */
export function isReferencedTypeNotDeletableError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /referenceddocumenttypenotdeletable/i.test(msg) ||
    /a deletabledocument reference at path .* requires a document type whose documents can be deleted/i.test(msg) ||
    hasConsensusCode(msg, [40131])
  )
}

/**
 * `TokenOncePerIdentityDistributionAlreadyClaimedError`, state code **40722**
 * (protocol 14, platform#4827): the identity already took a once-per-identity
 * token grant. Reached when a YAPP faucet-style grant is claimed twice; the
 * second claim is refused for good, and the user simply already has the tokens.
 * Message: "Token claim error: identity '<i>' already claimed the
 * once-per-identity distribution of token '<t>' at <ms>".
 */
export function isOncePerIdentityAlreadyClaimedError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /tokenonceperidentitydistributionalreadyclaimed/i.test(msg) ||
    /already claimed the once-per-identity distribution/i.test(msg) ||
    hasConsensusCode(msg, [40722])
  )
}

/**
 * **10421** `DocumentPropertyMaxBytesExceededError` (4.2.0-beta.4,
 * platform#4957): a string property is within its `maxLength` in characters
 * but over its `maxBytes` cap in UTF-8 — emoji and non-Latin scripts take up to
 * four bytes a character. The user can fix it by shortening the text.
 * Message: "Property <p> is <n> bytes in UTF-8, over its maxBytes of <m>".
 */
export function isPropertyMaxBytesError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /documentpropertymaxbytesexceeded/i.test(msg) ||
    /bytes in utf-8, over its maxbytes of/i.test(msg) ||
    hasConsensusCode(msg, [10421])
  )
}

/**
 * The document-level rules protocol 14 added in beta.4, other than `maxBytes`:
 *
 * - **10419** `DocumentPropertyNotDistinctError` (`distinctFrom`, #4917) — two
 *   identifier properties the type declares distinct are equal (following
 *   yourself, tipping yourself): "Document type "<t>" property "<p>" must
 *   differ from "<q>", but the two values are equal";
 * - **10422** `DocumentPropertyConstraintViolatedError` (`propertyConstraints`,
 *   #4962) — an integer rule between two properties failed: "A document of
 *   type "<t>" breaks its propertyConstraints rule "<rule>": <why>".
 *
 * Both are basic (unpaid) and permanent for the document as built.
 */
export function isDocumentPropertyRuleError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /documentpropertynotdistinct|documentpropertyconstraintviolated/i.test(msg) ||
    /must differ from .*, but the two values are equal/i.test(msg) ||
    /breaks its propertyconstraints rule/i.test(msg) ||
    hasConsensusCode(msg, [10419, 10422])
  )
}

/**
 * A `refersTo` whose target exists but does not satisfy what the reference
 * declares (4.2.0-beta.4) — contract-authoring or client-code mistakes, never a
 * dead target:
 *
 * - **40135** `ReferencedContractRequirementNotMetError` — "referenced contract
 *   <c> for path <p> does not meet the reference's requirement <f> <v>";
 * - **40136** `ReferencedIdentityKeyRequirementNotMetError` — "referenced public
 *   key <k> of identity <i> for <t>.<p> has <f> <v>, the reference requires <w>";
 * - **40137** `ReferencedDocumentLookupInvalidError` — "invalid refersTo lookup
 *   through index <i> declared at <p>: ...";
 * - **40138** `ReferencedDocumentListInvalidError` — "invalid refersTo
 *   listElement into inList <l> declared at <p>: ...".
 */
export function isReferenceRequirementError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /referencedcontractrequirementnotmet|referencedidentitykeyrequirementnotmet|referenceddocumentlookupinvalid|referenceddocumentlistinvalid/i.test(msg) ||
    /referenced contract .* does not meet the reference's requirement/i.test(msg) ||
    /referenced public key .* the reference requires/i.test(msg) ||
    /invalid refersto (lookup through index|listelement into inlist)/i.test(msg) ||
    hasConsensusCode(msg, [40135, 40136, 40137, 40138])
  )
}

/**
 * **40307** `VoteChoiceNotAllowedForVotePollError` (#4959): a masternode vote
 * named a choice the poll does not offer. Yappr casts no masternode votes
 * today; matched so a future election client never retries it.
 * Message: "VotePoll <p> does not allow the vote choice <c>".
 */
function isVoteChoiceNotAllowedError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /votechoicenotallowedforvotepoll/i.test(msg) ||
    /does not allow the vote choice/i.test(msg) ||
    hasConsensusCode(msg, [40307])
  )
}

/**
 * **41200** `ContractModeratedDocumentTypeNotYetUsableError` (elected
 * moderation, #4886/#4952): the contract declares elected moderation with a
 * `notYetUsable` interim, and no team is seated yet, so every document
 * transition on a moderated type is refused, paid. A user situation that lifts
 * on its own once an election seats a team — not by retrying.
 * Message: "Documents of type <t> on contract <c> can not be used until a
 * moderation team is seated".
 */
export function isModerationNotYetSeatedError(error: unknown): boolean {
  const msg = extractErrorMessage(error)
  return (
    /contractmoderateddocumenttypenotyetusable/i.test(msg) ||
    /can not be used until a moderation team is seated/i.test(msg) ||
    hasConsensusCode(msg, [41200])
  )
}

/**
 * What a refused MODERATION transition (ban, warn, delete, restore, fee claim,
 * or a charter write of the election flow) means, for the moderator client.
 * Null when the error is none of these. The codes are shared with ordinary
 * writes in two places — 40105 (a unique value taken) and 40111 (a contest
 * not joinable) — so only a caller that knows it sent a moderation or a
 * charter should ask.
 */
export type ModerationErrorKind =
  | 'NOT_MODERATOR'
  | 'NOT_WARNED'
  | 'WARNING_LIMIT'
  | 'NO_REMOVAL_RECORD'
  | 'RESTORE_WINDOW_ELAPSED'
  | 'RESTORE_HASH_MISMATCH'
  | 'ALREADY_RESTORED'
  | 'UNIQUE_VALUE_TAKEN'
  | 'NOT_YET_SEATED'
  | 'ABILITY_NOT_GRANTED'
  | 'ADDED_MODERATOR_LIMIT'
  | 'REASON_NOT_LISTED'
  | 'INVALID_REASON_DOCUMENTS'
  | 'CHARTER_INVALID'
  | 'CONTEST_NOT_JOINABLE'

/** Each kind: its consensus codes and the prose Drive renders (rs-dpp `#[error]`, 4.2.0-beta.4). */
const MODERATION_ERRORS: ReadonlyArray<readonly [ModerationErrorKind, readonly number[], RegExp]> = [
  // 41101 IdentityNotContractModeratorError; 41113 ContractFeeClaimNotAllowedError.
  // On an elected contract with a seated team the interim moderators, the owner
  // among them, get 41101 too, and the interim team's pot claim gets 41113.
  ['NOT_MODERATOR', [41101, 41113], /identitynotcontractmoderator|contractfeeclaimnotallowed|is not the owner or a moderator of contract|is not a recipient of the .* fee pot/i],
  ['NOT_WARNED', [41117], /contractusernotwarned|carries no warning on contract/i],
  ['WARNING_LIMIT', [41118], /contractuserwarninglimitreached|warnings on contract .* the most it may at a time/i],
  ['NO_REMOVAL_RECORD', [41119], /contractdocumentremovalnotfound|keeps no record of a moderator's deletion/i],
  ['RESTORE_WINDOW_ELAPSED', [41120], /documentrestorewindowelapsed|could be restored by moderators for .* milliseconds after that/i],
  ['RESTORE_HASH_MISMATCH', [41121], /documentrestorehashmismatch|the document brought back for .* hashes to/i],
  ['ALREADY_RESTORED', [41122], /contractdocumentalreadyrestored|was already restored by .*: it is live/i],
  // A restore re-inserts the document; a unique value someone took meanwhile
  // refuses it. The election flow meets it as a charter for a seated target.
  ['UNIQUE_VALUE_TAKEN', [40105], /duplicateuniqueindex|has duplicate unique properties/i],
  ['NOT_YET_SEATED', [41200], /contractmoderateddocumenttypenotyetusable|can not be used until a moderation team is seated/i],
  ['ABILITY_NOT_GRANTED', [41201], /contractmoderationabilitynotgranted|does not give its seated team the .* ability/i],
  ['ADDED_MODERATOR_LIMIT', [41202], /moderationcharteraddedmoderatorlimitreached|already has the .* added moderators contract/i],
  ['REASON_NOT_LISTED', [41203], /moderationreasonnotlisted|which the proposal .* of its seated team does not list/i],
  // 10904: over 16 documents, one named twice, or a malformed reasonDocumentId.
  ['INVALID_REASON_DOCUMENTS', [10904], /invalidcontractmoderationreasondocuments|the documents a contract moderation reason cites are invalid/i],
  ['CHARTER_INVALID', [11000, 11001], /moderationchartermalformedfield|moderationcharterrewardsplitnotonehundred|of the moderation charter is malformed|reward split of .* it must sum to 100%/i],
  ['CONTEST_NOT_JOINABLE', [40111], /documentcontestnotjoinable|document contest for vote_poll .* is not joinable/i],
]

export function classifyModerationError(error: unknown): ModerationErrorKind | null {
  const msg = extractErrorMessage(error)
  for (const [kind, codes, prose] of MODERATION_ERRORS) {
    if (prose.test(msg) || hasConsensusCode(msg, codes)) return kind
  }
  return null
}

/**
 * Every protocol-14 rejection above that is permanent for the transition as
 * built — the set `retryPostCreation` must never retry and `categorizeError`
 * must never present as transient. `isReferenceNotFoundError` and
 * `isImmutablePropertyChangedError` stay separate because they carry their own
 * user-facing messages and retry rules.
 */
export function isPermanentProtocol14Error(error: unknown): boolean {
  return (
    isInvalidDocumentIdError(error) ||
    isModerationBarredError(error) ||
    isGasPayerError(error) ||
    isActionFeeAgreementError(error) ||
    isReferencedTypeNotDeletableError(error) ||
    isOncePerIdentityAlreadyClaimedError(error) ||
    isPropertyMaxBytesError(error) ||
    isDocumentPropertyRuleError(error) ||
    isReferenceRequirementError(error) ||
    isVoteChoiceNotAllowedError(error) ||
    isModerationNotYetSeatedError(error)
  )
}

/**
 * Categorizes common Dash Platform errors and returns a user-friendly message.
 */
export function categorizeError(error: unknown): string {
  // Protocol-14 rejections, all permanent for the transition as built. Ordered
  // most-specific first; none may fall through to the "buy YAPP" or "network"
  // messages below, which would send the user chasing the wrong fix.
  if (isModerationBarredError(error)) {
    return 'Your account has been banned or suspended here by a moderator, so this action isn\'t allowed right now.'
  }
  if (isModerationNotYetSeatedError(error)) {
    return 'This opens once the community elects its moderation team. Nothing was posted.'
  }
  if (isPropertyMaxBytesError(error)) {
    // maxLength counts characters and the UI enforces it; maxBytes counts
    // UTF-8, where an emoji or a non-Latin letter takes up to four.
    return 'This is too long for the network once emoji and special characters are counted. Shorten it and try again.'
  }
  if (isDocumentPropertyRuleError(error)) {
    return 'The network doesn\'t allow this combination (for example, doing it to yourself). Nothing was charged.'
  }
  if (isOncePerIdentityAlreadyClaimedError(error)) {
    return 'You\'ve already claimed this — it can only be claimed once per account.'
  }
  if (isGasSponsorShortError(error)) {
    // Only reachable for a transition that INSISTS on the contract owner; Yappr
    // always prefers, which falls back to the signer instead of raising this.
    // Kept so it never reads as "buy more YAPP" if that ever changes.
    return 'Yappr couldn\'t cover the network fee for this right now. Try again, or switch to paying in credits.'
  }
  if (isGasPayerError(error)) {
    return 'This action can\'t be paid for right now. Nothing was charged — try again later.'
  }
  if (isFeeMultiplierNotToleratedError(error)) {
    return 'The network\'s fee level changed while this was being sent. Nothing was posted — try again.'
  }
  if (isActionFeeAgreementError(error)) {
    return 'This app is out of date with the network\'s fee rules. Reload to get the latest version.'
  }
  if (
    isInvalidDocumentIdError(error) ||
    isReferencedTypeNotDeletableError(error) ||
    isReferenceRequirementError(error) ||
    isVoteChoiceNotAllowedError(error)
  ) {
    // Both are code-level defects, not user situations; say so rather than
    // dressing them up as something the user can act on.
    return 'Something went wrong building this action, so the network refused it. Nothing was charged. Please report this.'
  }

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
    // Where the contract prices actions OPTIONALLY (v8), YAPP is not the only
    // way to act, and a balance that went stale between planning and signing
    // lands here: offering only to sell more would hide the free option. The
    // way out is read through the topology, so the advice never names one the
    // contract does not offer.
    return paymentIsChoosable('post')
      ? 'You don\'t have enough YAPP. Buy more, or switch to paying in credits in Settings.'
      : 'You don\'t have enough YAPP. Buy more to keep posting.'
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
