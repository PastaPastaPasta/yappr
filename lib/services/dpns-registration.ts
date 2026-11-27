/**
 * Registering a DPNS name as two journaled writes: the preorder, then the
 * domain (`lib/dpns/registration-journal.ts` says why and what is kept). Both
 * are built for the DPNS contract the network runs, read from its schema
 * ({@link dpnsPreorderLayout}): DPNS v3 (protocol 15) preorders by name hash,
 * v1 (protocol 14) by salted hash.
 *
 * Yappr builds both creates itself rather than calling the SDK's
 * `dpns.registerName`, which makes a fresh salt and preorder on every call and
 * hands back neither: a retry after a lost answer would pay a second preorder,
 * and a preorder that landed could never be used. Here each create goes
 * through `stateTransitionService.createDocument` (one write per identity and
 * contract at a time, nonce reservations, the signed bytes kept before the
 * broadcast) and an unconfirmed one is settled from its receipt
 * (`settleCreate`), never rebuilt while it may still land.
 *
 * Money: a contested name's domain pays into the vote exactly the deposit the
 * user approved. The fund to join is read again right before the domain is
 * signed and the domain is not signed when it differs
 * ({@link ContestFundChangedError}); the domain then states the approved
 * amount as the most it pays (protocol 14: Platform charges the fund to join
 * and refuses, charging only fees, when that is more). Each paid step first
 * checks the balance covers the deposit and the fees still to pay.
 */
import { logger } from '@/lib/logger'
import { withIdentityWriteLock } from '@/lib/identity-write-lock'
import { CREATE_NOT_RECORDED_ERROR, PENDING_WRITE_ERROR, extractErrorMessage } from '@/lib/error-utils'
import { identityContractNonceConsumed } from '@/lib/document-id'
import type { SigningKey } from '@/lib/auth/signing-keys'
import {
  clearRegistration,
  loadRegistration,
  newPreorderSalt,
  preorderNameHash,
  preorderOwnerNameHash,
  saltedDomainHash,
  saveRegistration,
  type DpnsRegistrationRecord,
} from '@/lib/dpns/registration-journal'
import {
  BalanceTooLowError,
  DOMAIN_ADMISSION_FLOOR,
  DOMAIN_FEE_FALLBACK,
  PREORDER_DELETE_FEE,
  PREORDER_FEE_FALLBACK,
  RegistrationPlanChangedError,
  approvedContestFund,
  creditsNeeded,
  shortBalanceMessage,
  type ContestFund,
  type DpnsNameQuote,
  type DpnsRegistrationPlan,
} from '@/lib/dpns/registration-quote'
import { DPNS_CONTRACT_ID } from '../constants'
import { getEvoSdk } from './evo-sdk-service'
import { documentBuilderService } from './document-builder-service'
import { bytesToBase64QueryOperand, identifierToBase58, requireDocumentIdentifierBytes } from './sdk-helpers'
import { stateTransitionService, type CreateReceipt } from './state-transition-service'
import { networkPlatformVersion } from '@/lib/platform-version.mjs'

type ConnectedSdk = Awaited<ReturnType<typeof getEvoSdk>>

/**
 * `registerUsername` stopped before anything was sent for this attempt: a
 * check, a read, the signer, or a deposit that changed. Nothing new was paid,
 * so a retry is safe (a preorder paid earlier is kept and reused). `cause` is
 * the original error.
 */
export class DpnsNotSentError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super(extractErrorMessage(cause))
    this.name = 'DpnsNotSentError'
    this.cause = cause
  }
}

/** Someone else holds the name: nothing was sent. */
export class DpnsNameTakenError extends Error {
  constructor(label: string) {
    super(`Username ${label} is already taken`)
    this.name = 'DpnsNameTakenError'
  }
}

/** Where a registration stands after a call. */
export type DpnsRegistrationOutcome =
  /** The name is this identity's. */
  | { state: 'registered' }
  /** The name went to its community vote with this identity as a contender. */
  | { state: 'joined-vote' }
  /**
   * A step was sent and no answer settled it yet: continuing settles it, and pays nothing new.
   * `stalled`: the network turned that step down for now (its nonce still free), so it may only
   * go through once its cause (a low balance, say) is gone.
   */
  | { state: 'pending'; step: 'preorder' | 'domain'; stalled?: boolean }

/** A registration step was sent and not settled yet. */
export const DPNS_STILL_CONFIRMING_MESSAGE = 'Still being confirmed. It may have gone through; continuing won’t charge you a second time.'

/** A registration step the network turned down for now. */
export const DPNS_STALLED_MESSAGE = 'The network turned this step down for now, so it hasn’t gone through yet. This is often a low balance: top up if needed, then continue. Nothing is charged twice.'

export const REGISTRATION_NOT_KEPT_MESSAGE = 'This browser couldn’t keep a record of the registration, so nothing was sent. Allow site storage or free up some space, then try again.'

export interface RegisterDpnsNameInput {
  /** The label as typed (DPNS keeps its case). */
  label: string
  /** The homograph-safe label (`sdk.dpns.convertToHomographSafe`). */
  normalizedLabel: string
  ownerId: string
  signingKey: SigningKey
  /** The deposit the user approved for a contested name, in credits. */
  contestFund?: bigint | null
  /**
   * The paid steps besides the domain the user's review showed
   * ({@link quoteDpnsName}): any other is not sent
   * ({@link RegistrationPlanChangedError}). Absent: no review to hold to.
   */
  approvedPlan?: DpnsRegistrationPlan
  /**
   * Who owns `normalizedLabel.dash` now: an identity id, or null when DPNS
   * answered that nobody does. Rejects when the read fails.
   */
  readOwner: (normalizedLabel: string) => Promise<string | null>
  /**
   * Resolves once what was just stored is durable (the mobile engine's
   * secure storage is written through to the Keychain asynchronously).
   * Awaited after a new registration's salt is stored, before its first send.
   */
  durable?: () => Promise<void>
}

/**
 * How the DPNS contract the network runs takes a preorder, read from its
 * schema (as rs-sdk `register_dpns_name` picks it): from v3 (protocol 15)
 * `nameHash` and `ownerNameHash`, a preorder living `ttlSeconds` that the
 * domain finds by its owner and name; before it (protocol 14) a
 * `saltedDomainHash` the domain reveals with its `preorderSalt`.
 */
export type DpnsPreorderLayout = { scheme: 'nameHash'; ttlSeconds: number | null } | { scheme: 'salted' }

export function dpnsPreorderLayout(documentSchemas: unknown): DpnsPreorderLayout {
  const preorder = (documentSchemas as { preorder?: { properties?: Record<string, unknown>; ttl?: unknown } } | null)?.preorder
  const properties = preorder?.properties ?? {}
  if ('nameHash' in properties && 'ownerNameHash' in properties) {
    return { scheme: 'nameHash', ttlSeconds: typeof preorder?.ttl === 'number' ? preorder.ttl : null }
  }
  if ('saltedDomainHash' in properties) return { scheme: 'salted' }
  throw new Error('The DPNS contract on this network takes a preorder this app cannot build')
}

/** The `preorder` document committing `ownerId` to `normalizedLabel.dash` under `layout`. */
export function preorderDocumentData(layout: DpnsPreorderLayout, ownerId: string, normalizedLabel: string, salt: Uint8Array): Record<string, Uint8Array> {
  if (layout.scheme === 'salted') return { saltedDomainHash: saltedDomainHash(salt, normalizedLabel) }
  return {
    ownerNameHash: preorderOwnerNameHash(requireDocumentIdentifierBytes(ownerId, 'ownerNameHash'), normalizedLabel),
    nameHash: preorderNameHash(normalizedLabel),
  }
}

/**
 * The `domain` document for `label`, as rs-sdk `register_dpns_name` builds it:
 * it reveals `salt` (`preorderSalt`) only before DPNS v3, whose domain finds
 * its preorder by owner and name.
 */
export function domainDocumentData(label: string, normalizedLabel: string, ownerId: string, layout: DpnsPreorderLayout, salt: Uint8Array): Record<string, unknown> {
  return {
    label,
    normalizedLabel,
    parentDomainName: 'dash',
    normalizedParentDomainName: 'dash',
    ...(layout.scheme === 'salted' ? { preorderSalt: salt } : {}),
    records: { identity: requireDocumentIdentifierBytes(ownerId, 'records.identity') },
    subdomainRules: { allowSubdomains: false },
  }
}

/**
 * How long before a v3 preorder expires it is no longer revealed: a domain
 * broadcast now lands in a later block, and a preorder expired by then is not
 * found (rs-sdk's `DPNS_PREORDER_REVEAL_MARGIN_MS`).
 */
export const PREORDER_REVEAL_MARGIN_MS = 60_000n

/**
 * Whether a preorder created at `createdAtMs`, of a type whose documents live
 * `ttlSeconds`, can still be revealed by a domain broadcast at `nowMs` (the
 * time of the block a proof reports).
 */
/** Whether a preorder this browser saw land at `landedAtMs` should still be revealable now. */
function preorderStillLives(landedAtMs: number | undefined, ttlSeconds: number | null): boolean {
  if (landedAtMs === undefined) return false
  return preorderRevealable(BigInt(landedAtMs), ttlSeconds, BigInt(Date.now()))
}

export function preorderRevealable(createdAtMs: bigint | undefined, ttlSeconds: number | null, nowMs: bigint): boolean {
  if (ttlSeconds === null || createdAtMs === undefined) return true
  return nowMs + PREORDER_REVEAL_MARGIN_MS < createdAtMs + BigInt(ttlSeconds) * 1000n
}

/** How many DPNS contract responses a registration reads for one proved at the version it was parsed under. */
const DPNS_CONTRACT_FETCH_ATTEMPTS = 3

/**
 * The DPNS contract the network stores now: the first response proved at the
 * protocol version the SDK parsed it under, the version unchanged across the
 * fetch (rs-sdk `fetch_current_dpns_contract`). A node behind an upgrade
 * proves the contract it replaced, whose preorder the domain cannot reveal.
 */
export async function fetchCurrentDpnsContract(sdk: ConnectedSdk) {
  // Learn the network's version first (rs-sdk refreshes it too): a proved answer teaches the SDK
  // a newer one, so a session still at 14 doesn't take a node behind the upgrade at its word.
  await sdk.protocol.versionUpgradeStateWithProof().catch((error: unknown) => {
    logger.warn('DPNS: could not refresh the protocol version:', extractErrorMessage(error))
  })
  let last: [number, number] | null = null
  for (let attempt = 0; attempt < DPNS_CONTRACT_FETCH_ATTEMPTS; attempt++) {
    const parsedUnder = sdk.version()
    const response = await sdk.contracts.fetchWithProof(DPNS_CONTRACT_ID)
    if (response.metadata.protocolVersion === parsedUnder && sdk.version() === parsedUnder) {
      if (!response.data) throw new Error('the DPNS contract could not be read')
      return response.data
    }
    last = [response.metadata.protocolVersion, parsedUnder]
  }
  throw new Error(`no DPNS contract response was proved at the protocol version it was read under (last proved at ${last?.[0]}, read under ${last?.[1]})`)
}

/** The DPNS contract the network stores now, and how it takes a preorder. Rejects when it can't be read. */
async function readDpnsContract(sdk: ConnectedSdk) {
  const contract = await fetchCurrentDpnsContract(sdk)
  const w = await import('@dashevo/wasm-sdk')
  return { contract, layout: dpnsPreorderLayout(contract.toJSON(networkPlatformVersion(w.PlatformVersion, sdk)).documentSchemas) }
}

/** The balance a domain must find beyond its fee to be admitted: DPNS v3's floor ({@link DOMAIN_ADMISSION_FLOOR}). */
export function admissionReserve(layout: DpnsPreorderLayout, domainFee: bigint): bigint {
  return layout.scheme === 'nameHash' && DOMAIN_ADMISSION_FLOOR > domainFee ? DOMAIN_ADMISSION_FLOOR - domainFee : 0n
}

/**
 * The paid steps besides the domain a registration of `normalizedLabel` takes
 * from here, decided as {@link registerDpnsName} decides them: on v3 from the
 * owner's preorder on chain and the journal; before it from the journal.
 */
async function plannedSteps(sdk: ConnectedSdk, layout: DpnsPreorderLayout, record: DpnsRegistrationRecord | null, ownerId: string, normalizedLabel: string): Promise<{ plan: DpnsRegistrationPlan; mayResend: boolean }> {
  // A preorder this browser sent and has no verdict for is continued, not paid again; should it
  // prove never recorded, the registration asks for a new quote before replacing it.
  const sentUnsettled = record?.preorder !== undefined && !record.preorderLanded
  if (layout.scheme === 'salted') return { plan: { preorder: !record?.preorderLanded && !sentUnsettled, deletePreorder: false, domain: true }, mayResend: false }
  const pending = await pendingPreorder(sdk, layout.ttlSeconds, ownerId, normalizedLabel)
  // A sent preorder the index shows landed needs no re-send; otherwise re-sending it may charge it.
  if (pending.state === 'revealable') return { plan: { preorder: false, deletePreorder: false, domain: true }, mayResend: false }
  if (sentUnsettled) return { plan: { preorder: false, deletePreorder: false, domain: true }, mayResend: true }
  if (pending.state === 'expiring') return { plan: { preorder: true, deletePreorder: true, domain: true }, mayResend: false }
  return { plan: { preorder: !(record?.preorderLanded && preorderStillLives(record.preorderLandedAt, layout.ttlSeconds)), deletePreorder: false, domain: true }, mayResend: false }
}

type DpnsContract = NonNullable<Awaited<ReturnType<ConnectedSdk['contracts']['fetch']>>>

/**
 * What `label`'s domain would pay into its vote now, or null when it goes to
 * none: the SDK reads the contest's contenders (the fund doubles from 250 of
 * them) for a domain built as it would be sent.
 */
export async function readContestFund(sdk: ConnectedSdk, ownerId: string, label: string, normalizedLabel: string, layout: DpnsPreorderLayout): Promise<ContestFund | null> {
  const document = await documentBuilderService.buildDocumentForCreate(
    DPNS_CONTRACT_ID,
    'domain',
    ownerId,
    domainDocumentData(label, normalizedLabel, ownerId, layout, new Uint8Array(32)),
    { entropy: crypto.getRandomValues(new Uint8Array(32)), identityContractNonce: 1n }
  )
  const fund = await sdk.documents.contestFundToJoin(document)
  return fund ? { indexName: fund.indexName, credits: BigInt(fund.credits) } : null
}

/** The network fees of a preorder and of `label`'s domain, priced offline from the DPNS contract. */
export async function readRegistrationFees(sdk: ConnectedSdk, contract: DpnsContract, label: string): Promise<{ preorder: bigint; domain: bigint }> {
  try {
    // getEvoSdk initialised this same glue; never compile the wasm a second time.
    const w = await import('@dashevo/wasm-sdk')
    const price = (type: string, fields: Record<string, { length: number }> = {}) =>
      BigInt(w.documentCreateCost(contract, type, { fields }, networkPlatformVersion(w.PlatformVersion, sdk)).totalCredits.newValues)
    const name = { length: label.length }
    return {
      preorder: price('preorder'),
      domain: price('domain', { label: name, normalizedLabel: name, parentDomainName: { length: 4 }, normalizedParentDomainName: { length: 4 } }),
    }
  } catch (error) {
    logger.warn('DPNS: could not price the registration; using the usual fees:', extractErrorMessage(error))
    return { preorder: PREORDER_FEE_FALLBACK, domain: DOMAIN_FEE_FALLBACK }
  }
}

/**
 * What registering `label` costs from here: its deposit (read now) and the
 * fees still to pay. What this browser already sent for it is not counted
 * again: continuing reuses it. A domain already sent costs nothing more (its
 * deposit, for a contested name, may already have left the balance); should
 * it be proved never recorded, continuing asks for a new review.
 */
export async function quoteDpnsName(sdk: ConnectedSdk, ownerId: string, label: string, normalizedLabel: string): Promise<DpnsNameQuote> {
  const record = loadRegistration(ownerId, normalizedLabel)
  if (record?.domain) return { label, contestFund: null, fees: 0n, plan: { preorder: false, deletePreorder: false, domain: false } }
  const { contract, layout } = await readDpnsContract(sdk)
  const [contestFund, fees, { plan, mayResend }] = await Promise.all([
    readContestFund(sdk, ownerId, label, normalizedLabel, layout),
    readRegistrationFees(sdk, contract, label),
    plannedSteps(sdk, layout, record, ownerId, normalizedLabel),
  ])
  // A v3 preorder sent without a verdict and not shown landed may be charged when re-sent on
  // continuing: the balance must hold its fee too, though the quote doesn't count it as a cost.
  return {
    label,
    contestFund,
    fees: (plan.preorder ? fees.preorder : 0n) + (plan.deletePreorder ? PREORDER_DELETE_FEE : 0n) + fees.domain,
    reserve: admissionReserve(layout, fees.domain) + (mayResend ? fees.preorder : 0n),
    plan,
  }
}

/**
 * Whether a preorder committing to `record`'s salt is on chain: one this
 * browser sent and lost track of (its receipt gone, or replaced). The salted
 * hash is unique, so sending another one would only be refused, and charged.
 * Rejects when the read fails.
 */
async function preorderOnChain(sdk: ConnectedSdk, record: DpnsRegistrationRecord): Promise<boolean> {
  return preorderWithHashExists(sdk, saltedDomainHash(record.salt, record.normalizedLabel))
}

/**
 * The v3 preorder `ownerId` holds of `normalizedLabel` (its `ownerAndNameHash`
 * index holds at most one): 'revealable', 'expiring' (expired or about to,
 * but not cleaned up yet: a reveal of it is refused, and so is another
 * preorder while it stands, so it is deleted first) or none. Rejects when the
 * read fails.
 */
async function pendingPreorder(
  sdk: ConnectedSdk,
  ttlSeconds: number | null,
  ownerId: string,
  normalizedLabel: string
): Promise<{ state: 'none' } | { state: 'revealable'; createdAtMs?: number } | { state: 'expiring'; documentId: string }> {
  const response = await sdk.documents.queryWithProof({
    dataContractId: DPNS_CONTRACT_ID,
    documentTypeName: 'preorder',
    where: [['$ownerId', '==', ownerId], ['nameHash', '==', bytesToBase64QueryOperand(preorderNameHash(normalizedLabel))]],
    limit: 1,
  })
  const preorder = [...response.data.values()].find((document) => document !== undefined)
  if (!preorder) return { state: 'none' }
  if (preorderRevealable(preorder.createdAt, ttlSeconds, BigInt(response.metadata.timeMs))) {
    return { state: 'revealable', ...(preorder.createdAt !== undefined ? { createdAtMs: Number(preorder.createdAt) } : {}) }
  }
  const documentId = identifierToBase58(preorder.id)
  if (!documentId) throw new Error('the expiring DPNS preorder has no readable id')
  return { state: 'expiring', documentId }
}

/**
 * Whether DPNS holds a preorder carrying `hash` (its `saltedHash` index, the
 * bytes as a base64 operand). Rejects when the read fails.
 * @public exercised on sakura by the mobile engine's write suite
 */
export async function preorderWithHashExists(sdk: ConnectedSdk, hash: Uint8Array): Promise<boolean> {
  const response: unknown = await sdk.documents.query({
    dataContractId: DPNS_CONTRACT_ID,
    documentTypeName: 'preorder',
    where: [['saltedDomainHash', '==', bytesToBase64QueryOperand(hash)]],
    limit: 1,
  })
  if (response instanceof Map) return [...response.values()].some(Boolean)
  if (Array.isArray(response)) return response.some(Boolean)
  return false
}

/** Whether `ownerId` is a contender in `normalizedLabel`'s vote, proved at `height`. Rejects when the read fails.
 * @public exercised on sakura by the mobile engine's write suite
 */
export async function readContender(sdk: ConnectedSdk, ownerId: string, normalizedLabel: string): Promise<{ contender: boolean; height: number | bigint }> {
  const vote = await sdk.voting.contestedResourceVoteStateWithProof({
    dataContractId: DPNS_CONTRACT_ID,
    documentTypeName: 'domain',
    indexName: 'parentNameAndLabel',
    indexValues: ['dash', normalizedLabel],
    resultType: 'documentsAndVoteTally',
    startAtContenderId: ownerId,
    startAtIncluded: true,
    limit: 1,
  })
  const contenders: Array<{ identityId?: unknown }> = vote.data?.contenders ?? []
  return { contender: contenders.some((contender) => identifierToBase58(contender.identityId) === ownerId), height: vote.metadata.height }
}

/**
 * Where a contested domain this browser sent stands, from proofs: 'joined'
 * when its owner is a contender in the name's vote; 'refused' when its nonce
 * is spent and a vote proved at that height or later does not list the owner
 * (it executed and was refused, so a new domain may be built); otherwise
 * 'unknown'. A contested domain is stored in its vote, not by id, so its
 * absence by id proves nothing.
 */
async function contestedDomainState(sdk: ConnectedSdk, receipt: CreateReceipt, normalizedLabel: string): Promise<'joined' | 'refused' | 'unknown'> {
  try {
    const nonce = await sdk.identities.contractNonceWithProof(receipt.ownerId, DPNS_CONTRACT_ID)
    const vote = await readContender(sdk, receipt.ownerId, normalizedLabel)
    if (vote.contender) return 'joined'
    if (identityContractNonceConsumed(nonce.data, receipt.nonce) && vote.height >= nonce.metadata.height) return 'refused'
  } catch (error) {
    logger.warn(`DPNS: could not read the vote for ${normalizedLabel}:`, extractErrorMessage(error))
  }
  return 'unknown'
}

async function balanceOf(sdk: ConnectedSdk, ownerId: string): Promise<bigint> {
  const identity = await sdk.identities.fetch(ownerId)
  if (!identity) throw new Error('Identity not found')
  return BigInt(identity.balance)
}

/** Refuse unless the balance pays `needed`: the deposit and the fees still to pay. */
async function requireBalance(sdk: ConnectedSdk, ownerId: string, needed: bigint): Promise<void> {
  let balance: bigint
  try {
    balance = await balanceOf(sdk, ownerId)
  } catch (error) {
    throw new DpnsNotSentError(error)
  }
  const short = shortBalanceMessage(balance, needed)
  if (short) throw new DpnsNotSentError(new BalanceTooLowError(short))
}

function save(record: DpnsRegistrationRecord): void {
  if (!saveRegistration(record)) throw new DpnsNotSentError(new Error(REGISTRATION_NOT_KEPT_MESSAGE))
}

/**
 * One create of the registration, its receipt kept in the record (under
 * `step`) before it is broadcast. Resolves 'confirmed' or 'pending'; a refusal
 * (or a create that was never sent) rejects, with the step's receipt dropped:
 * it will not execute. A replacement (`replacesNonce`) keeps the receipt it
 * replaces on any failure: that one may still land.
 */
async function sendStep(
  record: DpnsRegistrationRecord,
  step: 'preorder' | 'domain',
  data: Record<string, unknown>,
  options: { signingKey: SigningKey; replacesNonce?: bigint; prefundedVotingBalance?: ContestFund }
): Promise<'confirmed' | 'pending'> {
  let sent = false
  const replaced = record[step]
  const result = await stateTransitionService.createDocument(DPNS_CONTRACT_ID, step, record.ownerId, data, {
    signingKey: options.signingKey,
    ...(options.replacesNonce !== undefined ? { replacesNonce: options.replacesNonce } : {}),
    ...(options.prefundedVotingBalance ? { prefundedVotingBalance: options.prefundedVotingBalance } : {}),
    reservationScope: `dpns:${step}:${record.normalizedLabel}`,
    beforeBroadcast: (receipt?: CreateReceipt) => {
      if (!receipt) throw new Error('A DPNS create has no receipt')
      record[step] = receipt
      if (step === 'domain') record.domainContested = options.prefundedVotingBalance !== undefined
      // Throwing here refuses the broadcast: nothing goes out that could not be resumed.
      if (!saveRegistration(record)) throw new Error(REGISTRATION_NOT_KEPT_MESSAGE)
      sent = true
    },
  })
  if (result.success) return result.confirmed === false ? 'pending' : 'confirmed'
  // "Not recorded" is read by id, where a contested domain never is (it is stored in its vote):
  // only the vote settles it, so it stays pending with its receipt.
  if (sent && options.prefundedVotingBalance && result.error === CREATE_NOT_RECORDED_ERROR) return 'pending'
  const error = new Error(result.error || 'Registration failed')
  if (options.replacesNonce !== undefined) {
    // The stalled create it replaces may still land: keep it. Its nonce taken meanwhile
    // (PENDING_WRITE_ERROR), or the replacement read absent at it, means one of them executed.
    record[step] = replaced
    saveRegistration(record)
    if (result.error === PENDING_WRITE_ERROR || result.error === CREATE_NOT_RECORDED_ERROR) return 'pending'
    throw sent ? error : new DpnsNotSentError(error)
  }
  delete record[step]
  if (step === 'domain') delete record.domainContested
  saveRegistration(record)
  throw sent ? error : new DpnsNotSentError(error)
}

/**
 * Settle a domain this browser sent. 'registered'/'joined-vote' when it
 * landed, 'resend' when it is proved never recorded (its preorder still
 * stands, so a new domain may be built), 'pending' otherwise. A contested
 * domain is stored in its vote, not by id, so only the vote proves it: its
 * absence by id never counts as "not recorded".
 */
async function settleDomain(sdk: ConnectedSdk, record: DpnsRegistrationRecord): Promise<DpnsRegistrationOutcome | 'resend'> {
  const receipt = record.domain as CreateReceipt
  if (record.domainContested) {
    const before = await contestedDomainState(sdk, receipt, record.normalizedLabel)
    if (before === 'joined') return { state: 'joined-vote' }
    if (before === 'refused') return 'resend'
    // Re-sends the same bytes while their nonce is free; its verdict by id means nothing here,
    // but 'stalled' (re-sent, refused for now, nonce still free) is worth saying.
    const settled = await stateTransitionService.settleCreate(receipt)
    const after = await contestedDomainState(sdk, receipt, record.normalizedLabel)
    if (after === 'joined') return { state: 'joined-vote' }
    if (after === 'refused') return 'resend'
    return { state: 'pending', step: 'domain', ...(settled === 'stalled' ? { stalled: true } : {}) }
  }
  const settled = await stateTransitionService.settleCreate(receipt)
  if (settled === 'landed') return { state: 'registered' }
  if (settled === 'not-recorded') return 'resend'
  return { state: 'pending', step: 'domain', ...(settled === 'stalled' ? { stalled: true } : {}) }
}

/** Register (or continue registering) a name; see the module comment. */
export async function registerDpnsName(input: RegisterDpnsNameInput): Promise<DpnsRegistrationOutcome> {
  return withIdentityWriteLock(input.ownerId, 'dpns-registration', () => registerLocked(input))
}

async function registerLocked(input: RegisterDpnsNameInput): Promise<DpnsRegistrationOutcome> {
  const { label, normalizedLabel, ownerId, signingKey } = input
  const sdk = await getEvoSdk()
  let record = loadRegistration(ownerId, normalizedLabel)
  const finished = (outcome: DpnsRegistrationOutcome): DpnsRegistrationOutcome => {
    if (outcome.state !== 'pending') clearRegistration(ownerId, normalizedLabel)
    return outcome
  }

  // Registered already (this registration's domain landed, maybe in another tab), or taken.
  let owner: string | null
  try {
    owner = await input.readOwner(normalizedLabel)
  } catch (error) {
    // Something of it is out and the name can't be read: say so rather than send more.
    if (record?.preorder && !record.preorderLanded) return { state: 'pending', step: 'preorder' }
    if (record?.domain) return { state: 'pending', step: 'domain' }
    throw new DpnsNotSentError(error)
  }
  if (owner === ownerId) return finished({ state: 'registered' })
  if (owner !== null) {
    clearRegistration(ownerId, normalizedLabel)
    throw new DpnsNotSentError(new DpnsNameTakenError(label))
  }

  if (record?.domain) {
    const settled = await settleDomain(sdk, record)
    if (settled !== 'resend') return finished(settled)
    delete record.domain
    delete record.domainContested
    if (!saveRegistration(record)) return { state: 'pending', step: 'domain' }
  }

  let dpns: Awaited<ReturnType<typeof readDpnsContract>>
  try {
    dpns = await readDpnsContract(sdk)
  } catch (error) {
    throw new DpnsNotSentError(error)
  }
  const { layout } = dpns
  const fees = await readRegistrationFees(sdk, dpns.contract, label)

  // Already a contender: a domain this browser sent and lost the receipt of (the app killed
  // right after the broadcast, storage partly cleared). Another would be refused, and charged.
  // Read first: from v3 the domain consumed its preorder, so the preorder step would pay again.
  if ((await approvedFund(sdk, input, layout)) && (await isContender(sdk, ownerId, normalizedLabel))) return finished({ state: 'joined-vote' })

  const prepared = layout.scheme === 'salted'
    ? await prepareSaltedPreorder(sdk, input, record, fees)
    : await prepareNamePreorder(sdk, input, record, fees, layout.ttlSeconds)
  if ('state' in prepared) return prepared
  record = prepared

  // The domain: one the review counted, and the deposit read right before signing the approved one.
  requirePlanned(input, 'domain')
  const contestFund = await approvedFund(sdk, input, layout)
  await requireBalance(sdk, ownerId, creditsNeeded({ contestFund, fees: fees.domain, reserve: admissionReserve(layout, fees.domain) }))
  const domain = await sendStep(record, 'domain', domainDocumentData(record.label, normalizedLabel, ownerId, layout, record.salt), {
    signingKey,
    ...(contestFund ? { prefundedVotingBalance: contestFund } : {}),
  })
  if (domain === 'pending') return { state: 'pending', step: 'domain' }
  return finished(contestFund ? { state: 'joined-vote' } : { state: 'registered' })
}

type Fees = { preorder: bigint; domain: bigint }
type Prepared = DpnsRegistrationRecord | DpnsRegistrationOutcome

async function isContender(sdk: ConnectedSdk, ownerId: string, normalizedLabel: string): Promise<boolean> {
  try {
    return (await readContender(sdk, ownerId, normalizedLabel)).contender
  } catch (error) {
    throw new DpnsNotSentError(error)
  }
}

/** A new registration record, kept (and made durable) before anything of it is paid. */
async function startRecord(input: RegisterDpnsNameInput): Promise<DpnsRegistrationRecord> {
  const record = { ownerId: input.ownerId, label: input.label, normalizedLabel: input.normalizedLabel, salt: newPreorderSalt() }
  save(record)
  // Before v3 the salt is what makes the preorder usable: it must outlive this call before one is paid.
  await durable(input)
  return record
}

/**
 * Settle the preorder `record` sent and has no verdict for: null while it may
 * still land unseen, else whether it was just seen landing, or the nonce a new
 * one replaces it at ('stalled': it may still land, so its receipt stays until
 * the replacement goes out).
 */
async function settlePreorder(record: DpnsRegistrationRecord, { proofOnly = false }: { proofOnly?: boolean } = {}): Promise<{ replacesNonce?: bigint; landedNow?: boolean } | null> {
  if (!record.preorder || record.preorderLanded) return {}
  const settled = proofOnly
    ? await stateTransitionService.settleCreate(record.preorder, { mayResend: () => false })
    : await stateTransitionService.settleCreate(record.preorder)
  if (settled === null) return null
  if (settled === 'landed') {
    // Proved by id, not when it was created: no lifetime is kept for it.
    record.preorderLanded = true
    delete record.preorderLandedAt
    return saveRegistration(record) ? { landedNow: true } : null
  }
  if (settled === 'stalled') return { replacesNonce: record.preorder.nonce }
  delete record.preorder
  saveRegistration(record)
  return {}
}

/** Pay the preorder of `record` (its receipt kept first); the record once it landed. */
async function sendPreorder(
  input: RegisterDpnsNameInput,
  record: DpnsRegistrationRecord,
  layout: DpnsPreorderLayout,
  replacesNonce: bigint | undefined
): Promise<Prepared> {
  const data = preorderDocumentData(layout, input.ownerId, input.normalizedLabel, record.salt)
  const preorder = await sendStep(record, 'preorder', data, { signingKey: input.signingKey, replacesNonce })
  if (preorder === 'pending') return { state: 'pending', step: 'preorder' }
  record.preorderLanded = true
  record.preorderLandedAt = Date.now()
  // Landed, and its receipt is stored: a record that fails to say so is settled next time.
  if (!saveRegistration(record)) return { state: 'pending', step: 'preorder' }
  return record
}

/** Refuse a paid step the user's review did not show. */
function requirePlanned(input: RegisterDpnsNameInput, step: keyof DpnsRegistrationPlan): void {
  if (input.approvedPlan && !input.approvedPlan[step]) throw new DpnsNotSentError(new RegistrationPlanChangedError(input.label))
}

/**
 * Before paying a preorder (and deleting an expiring one first): both must be
 * in the review, the deposit must be the approved one, and the balance must
 * pay them, the domain, and what the domain must find to be admitted.
 */
async function requirePreorderFunds(sdk: ConnectedSdk, input: RegisterDpnsNameInput, layout: DpnsPreorderLayout, fees: Fees, deletePreorder = false, replacing = false): Promise<void> {
  // A replacement at a stalled preorder's nonce stands in for that one: at most one executes.
  if (!replacing) requirePlanned(input, 'preorder')
  if (deletePreorder) requirePlanned(input, 'deletePreorder')
  await requirePreorderBalance(sdk, input, layout, fees, deletePreorder)
}

/** The deposit must be the approved one, and the balance must pay a preorder, its domain and the domain's admission. */
async function requirePreorderBalance(sdk: ConnectedSdk, input: RegisterDpnsNameInput, layout: DpnsPreorderLayout, fees: Fees, deletePreorder = false): Promise<void> {
  const contestFund = await approvedFund(sdk, input, layout)
  const stepFees = fees.preorder + fees.domain + (deletePreorder ? PREORDER_DELETE_FEE : 0n)
  await requireBalance(sdk, input.ownerId, creditsNeeded({ contestFund, fees: stepFees, reserve: admissionReserve(layout, fees.domain) }))
}

/**
 * Protocol 14 (DPNS v1): the preorder of `record`'s salt, settled, found on
 * chain or paid. A preorder that landed is used for as long as the record
 * keeps its salt.
 */
async function prepareSaltedPreorder(sdk: ConnectedSdk, input: RegisterDpnsNameInput, record: DpnsRegistrationRecord | null, fees: Fees): Promise<Prepared> {
  const layout: DpnsPreorderLayout = { scheme: 'salted' }
  if (record?.preorderLanded) return record
  const settled = record ? await settlePreorder(record) : {}
  if (settled === null) return { state: 'pending', step: 'preorder' }
  if (record?.preorderLanded) return record
  // A preorder with this salt already on chain (its receipt lost or replaced) is the one to
  // use: the salted hash is unique, so another would only be refused, and charged.
  if (record) {
    let onChain: boolean
    try {
      onChain = await preorderOnChain(sdk, record)
    } catch (error) {
      if (record.preorder) return { state: 'pending', step: 'preorder', ...(settled.replacesNonce !== undefined ? { stalled: true } : {}) }
      throw new DpnsNotSentError(error)
    }
    if (onChain) {
      record.preorderLanded = true
      return saveRegistration(record) ? record : { state: 'pending', step: 'preorder' }
    }
  }
  await requirePreorderFunds(sdk, input, layout, fees, false, settled.replacesNonce !== undefined)
  return sendPreorder(input, record ?? await startRecord(input), layout, settled.replacesNonce)
}

/**
 * Protocol 15 (DPNS v3): the owner's preorder of the name, as the chain holds
 * it. A preorder lives an hour, so one this browser saw land may be gone or
 * about to expire: the chain is read every time. A revealable one is used
 * (whoever sent it); an expiring one is deleted and the name preordered anew,
 * as rs-sdk `register_dpns_name` does.
 */
async function prepareNamePreorder(
  sdk: ConnectedSdk,
  input: RegisterDpnsNameInput,
  record: DpnsRegistrationRecord | null,
  fees: Fees,
  ttlSeconds: number | null
): Promise<Prepared> {
  const layout: DpnsPreorderLayout = { scheme: 'nameHash', ttlSeconds }
  // A sent preorder is settled by proof first, then read on the index: only one neither shows is
  // re-sent, which may charge it, so only once the balance holds it, the domain and its admission.
  let settled = record ? await settlePreorder(record, { proofOnly: true }) : {}
  let pending: Awaited<ReturnType<typeof pendingPreorder>>
  try {
    pending = await pendingPreorder(sdk, ttlSeconds, input.ownerId, input.normalizedLabel)
  } catch (error) {
    if (record?.preorder && !record.preorderLanded) return { state: 'pending', step: 'preorder', ...(settled?.replacesNonce !== undefined ? { stalled: true } : {}) }
    throw new DpnsNotSentError(error)
  }
  if (pending.state !== 'revealable' && settled === null && record) {
    await requirePreorderBalance(sdk, input, layout, fees)
    settled = await settlePreorder(record)
  }
  if (pending.state === 'revealable') {
    const kept = record ?? await startRecord(input)
    kept.preorderLanded = true
    kept.preorderLandedAt = pending.createdAtMs ?? kept.preorderLandedAt
    return saveRegistration(kept) ? kept : { state: 'pending', step: 'preorder' }
  }
  if (settled === null) return { state: 'pending', step: 'preorder' }
  // Seen landing within its lifetime but not read back (a node behind): reveal it rather than
  // pay another, which the network would refuse while it stands. A domain refused for want of
  // it reads the chain again next time.
  if (pending.state === 'none' && record?.preorderLanded && (settled.landedNow || preorderStillLives(record.preorderLandedAt, ttlSeconds))) return record
  await requirePreorderFunds(sdk, input, layout, fees, pending.state === 'expiring', settled.replacesNonce !== undefined)
  const kept = record ?? await startRecord(input)
  if (pending.state === 'expiring') {
    const deleted = await stateTransitionService.deleteDocument(DPNS_CONTRACT_ID, 'preorder', pending.documentId, input.ownerId, undefined, { signingKey: input.signingKey })
    if (!deleted.success) throw new Error(deleted.error || 'The expired preorder could not be removed')
  }
  delete kept.preorderLanded
  delete kept.preorderLandedAt
  if (settled.replacesNonce === undefined) delete kept.preorder
  if (!saveRegistration(kept)) throw new Error(REGISTRATION_NOT_KEPT_MESSAGE)
  return sendPreorder(input, kept, layout, settled.replacesNonce)
}

/** {@link RegisterDpnsNameInput.durable}; a failure sends nothing. */
async function durable(input: RegisterDpnsNameInput): Promise<void> {
  try {
    await input.durable?.()
  } catch (error) {
    throw new DpnsNotSentError(error)
  }
}

/**
 * The deposit read now, when it is the one the user approved
 * ({@link approvedContestFund}); a refusal or a failed read sends nothing.
 */
async function approvedFund(sdk: ConnectedSdk, input: RegisterDpnsNameInput, layout: DpnsPreorderLayout): Promise<ContestFund | null> {
  try {
    return approvedContestFund(input.label, input.contestFund, await readContestFund(sdk, input.ownerId, input.label, input.normalizedLabel, layout))
  } catch (error) {
    throw new DpnsNotSentError(error)
  }
}
