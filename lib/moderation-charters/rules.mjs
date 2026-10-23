/**
 * The moderation charters rules that both the release CLI
 * (scripts/file-release-charters.mjs) and the app's Moderation teams page
 * (components/moderation-teams/) follow, so a charter the page files and one
 * the CLI files pass the same checks:
 *
 * - the charters system contract's limits (rs-dpp schema v1, Platform
 *   v5.0.0-rc.4 `packages/moderation-charters-contract`);
 * - the 0.5 DASH contest deposit an application pays, and the balances a
 *   leader and a member need;
 * - a charter's terms (description, reasons, moderators' share, reward split);
 * - which identity key is a charter key (bound to a charters document type);
 * - the election clock: when applications open, when the join window closes,
 *   and the phase a contest is in.
 *
 * Pure: no SDK, no Node and no DOM. Types: rules.d.mts.
 */

export const CHARTERS_CONTRACT_ID = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88'

/** What an application pays into the masternode vote: 0.5 DASH, not the 0.1 DASH of a DPNS contest. */
export const CONTEST_FUND_CREDITS = 50_000_000_000n
/** A leader keeps the deposit plus room for the application's own fee: 0.51 DASH. */
export const LEADER_MINIMUM_CREDITS = 51_000_000_000n
/** A member's reserve for its key and join request: 0.001 DASH. */
export const MEMBER_MINIMUM_CREDITS = 100_000_000n

/** The schema's limits on each charter document. */
export const CHARTER_LIMITS = Object.freeze({
  /** UTF-8 bytes (so at most 4096 characters too). */
  descriptionBytes: 4096,
  reasons: 64,
  members: 15,
  /** A join or resignation message, before encryption (the SDK's limit). */
  messageBytes: 1023,
  reasonLabelChars: 64,
  reasonDescriptionChars: 1024,
})

export const DEFAULT_REWARD_SPLIT = Object.freeze({ leader: 40, equal: 30, actions: 30 })
export const DEFAULT_MODERATORS_SHARE = 60

const REASON_CODE = /^[A-Z]{3}$/
const SPLIT_KEYS = ['leader', 'equal', 'actions']

/** The UTF-8 length of `text`, the unit the schema's description and message limits count in. */
export const utf8Bytes = (text) => new TextEncoder().encode(text).length
const chars = (text) => [...text].length
const percent = (value) => Number.isInteger(value) && value >= 0 && value <= 100

/** The problem with one reason (`code`, `label`, optional `description`), or null. */
export function reasonProblem(reason) {
  if (!reason || typeof reason.code !== 'string' || !REASON_CODE.test(reason.code)) {
    return { field: 'code', message: 'A reason code is three capital letters, like SPM.' }
  }
  if (typeof reason.label !== 'string' || !reason.label.trim() || chars(reason.label) > CHARTER_LIMITS.reasonLabelChars) {
    return { field: 'label', message: `Give the reason a name of up to ${CHARTER_LIMITS.reasonLabelChars} characters.` }
  }
  if (reason.description !== undefined
    && (typeof reason.description !== 'string' || !reason.description.length || chars(reason.description) > CHARTER_LIMITS.reasonDescriptionChars)) {
    return { field: 'description', message: `A reason's description is 1 to ${CHARTER_LIMITS.reasonDescriptionChars} characters.` }
  }
  return null
}

/**
 * Every problem with a charter's terms, one per field, in form order: an empty
 * list means the charters contract will accept them. `reasons` is the list of
 * reasons the charter names (ids or drafts: only the count and uniqueness of
 * `key(reason)` are checked here). A charter with no reasons is refused: the
 * schema allows it, but its team could never act.
 */
export function charterTermsProblems({ description, reasons, moderatorsShare, rewardSplit }, key = (reason) => reason) {
  const problems = []
  if (typeof description !== 'string' || !description.trim()) {
    problems.push({ field: 'description', message: 'Describe what the team will moderate and how.' })
  } else if (utf8Bytes(description) > CHARTER_LIMITS.descriptionBytes) {
    problems.push({ field: 'description', message: `The description is too long: at most ${CHARTER_LIMITS.descriptionBytes} bytes (emoji and accented letters take more than one).` })
  }
  if (!Array.isArray(reasons) || reasons.length === 0) {
    problems.push({ field: 'reasons', message: 'Pick at least one reason. A team can only act on the reasons its charter lists.' })
  } else if (reasons.length > CHARTER_LIMITS.reasons) {
    problems.push({ field: 'reasons', message: `A charter lists at most ${CHARTER_LIMITS.reasons} reasons.` })
  } else if (new Set(reasons.map(key)).size !== reasons.length) {
    problems.push({ field: 'reasons', message: 'Each reason can be listed once.' })
  }
  if (!percent(moderatorsShare)) {
    problems.push({ field: 'moderatorsShare', message: "The moderators' share is a whole number from 0 to 100." })
  }
  if (!rewardSplit || !SPLIT_KEYS.every((part) => percent(rewardSplit[part]))) {
    problems.push({ field: 'rewardSplit', message: 'Each part of the reward split is a whole number from 0 to 100.' })
  } else if (rewardSplit.leader + rewardSplit.equal + rewardSplit.actions !== 100) {
    problems.push({ field: 'rewardSplit', message: `The reward split must add up to 100 (it adds up to ${rewardSplit.leader + rewardSplit.equal + rewardSplit.actions}).` })
  }
  return problems
}

/** The problem with a join or resignation message, or null (an empty one is allowed). */
export function messageProblem(message) {
  if (typeof message !== 'string') return 'The message must be text.'
  if (utf8Bytes(message) > CHARTER_LIMITS.messageBytes) return `The message is too long: at most ${CHARTER_LIMITS.messageBytes} bytes.`
  return null
}

/**
 * Whether `key` (an identity public key as the SDK returns it) is an enabled
 * MEDIUM secp256k1 key of `purpose` ('ENCRYPTION' or 'DECRYPTION') bound to
 * the charters contract's `documentType`: the keys join and resignation
 * requests are encrypted between (`joinRequest` for a member's, and
 * `submittedCharter` for a leader's).
 */
export function isCharterKey(key, purpose, documentType) {
  if (!key || (key.disabledAt !== undefined && key.disabledAt !== null)) return false
  const bounds = key.contractBounds?.toJSON?.()
  return key.purpose === purpose && key.securityLevel === 'MEDIUM' && key.keyType === 'ECDSA_SECP256K1'
    && bounds?.$type === 'documentType' && bounds.id === CHARTERS_CONTRACT_ID && bounds.documentTypeName === documentType
}

/** The charter key each role holds: a leader's receives join requests, a member's sends them. */
export const CHARTER_KEYS = Object.freeze({
  leader: Object.freeze({ purpose: 'DECRYPTION', documentType: 'submittedCharter' }),
  member: Object.freeze({ purpose: 'ENCRYPTION', documentType: 'joinRequest' }),
})

/** Platform opens the first application at the target's creation block time plus its `electionDelay`. */
export function electionOpensAtMs(creationTimeMs, delaySeconds) {
  if (!Number.isFinite(Number(creationTimeMs)) || !Number.isSafeInteger(Number(delaySeconds)) || Number(delaySeconds) < 0) return null
  return Number(creationTimeMs) + Number(delaySeconds) * 1000
}

/**
 * When the join window closes, from the contest's poll end: a sole applicant's
 * poll ends at join close, and a second applicant moves the end out by the
 * vote window.
 */
export function joinClosesAtMs(pollEndsAtMs, contenders, voteWindowSeconds) {
  if (pollEndsAtMs === null || pollEndsAtMs === undefined || !Number.isFinite(Number(pollEndsAtMs))) return null
  return Number(pollEndsAtMs) - (contenders > 1 ? voteWindowSeconds * 1000 : 0)
}

/**
 * The phase of a target's contest: `seated` (a team holds the seat),
 * `decided` (the poll has a winner not yet read as seated), `none` (nobody has
 * applied), `joining` (the join window is open), `voting` (masternodes vote),
 * or `unknown` (applicants exist but the clock could not be read).
 */
export function contestPhase({ seated, decided, contenders, joinClosesAtMs: closes, chainTimeMs }) {
  if (seated) return 'seated'
  if (decided) return 'decided'
  if (contenders === 0) return 'none'
  if (closes === null || closes === undefined || !Number.isFinite(chainTimeMs)) return 'unknown'
  return chainTimeMs < closes ? 'joining' : 'voting'
}

/** The contest fund a create states must be exactly the reviewed 0.5 DASH. */
export function assertContestFund(credits) {
  if (credits === null || credits === undefined || BigInt(credits) !== CONTEST_FUND_CREDITS) {
    throw new Error('contest fund differs from the reviewed 0.5 DASH budget; stop and review')
  }
}

/** `text` with anything shaped like a private key (WIF or 64 hex digits) blanked out. */
export function redactSecrets(text) {
  return String(text).replace(/\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, '[redacted key]').replace(/\b[0-9a-f]{64}\b/gi, '[redacted hex]')
}
