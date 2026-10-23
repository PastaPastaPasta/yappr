/**
 * Registering a DPNS name as two journaled writes: the preorder, then the
 * domain (`lib/dpns/registration-journal.ts` says why and what is kept).
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
  saltedDomainHash,
  saveRegistration,
  type DpnsRegistrationRecord,
} from '@/lib/dpns/registration-journal'
import {
  BalanceTooLowError,
  DOMAIN_FEE_FALLBACK,
  PREORDER_FEE_FALLBACK,
  approvedContestFund,
  creditsNeeded,
  shortBalanceMessage,
  type ContestFund,
  type DpnsNameQuote,
} from '@/lib/dpns/registration-quote'
import { DPNS_CONTRACT_ID } from '../constants'
import { getEvoSdk } from './evo-sdk-service'
import { documentBuilderService } from './document-builder-service'
import { bytesToBase64QueryOperand, identifierToBase58, requireDocumentIdentifierBytes } from './sdk-helpers'
import { stateTransitionService, type CreateReceipt } from './state-transition-service'

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

/** The `domain` document for `label`, as rs-sdk `register_dpns_name` builds it. */
export function domainDocumentData(label: string, normalizedLabel: string, ownerId: string, salt: Uint8Array): Record<string, unknown> {
  return {
    label,
    normalizedLabel,
    parentDomainName: 'dash',
    normalizedParentDomainName: 'dash',
    preorderSalt: salt,
    records: { identity: requireDocumentIdentifierBytes(ownerId, 'records.identity') },
    subdomainRules: { allowSubdomains: false },
  }
}

/**
 * What `label`'s domain would pay into its vote now, or null when it goes to
 * none: the SDK reads the contest's contenders (the fund doubles from 250 of
 * them) for a domain built as it would be sent.
 */
export async function readContestFund(sdk: ConnectedSdk, ownerId: string, label: string, normalizedLabel: string): Promise<ContestFund | null> {
  const document = await documentBuilderService.buildDocumentForCreate(
    DPNS_CONTRACT_ID,
    'domain',
    ownerId,
    domainDocumentData(label, normalizedLabel, ownerId, new Uint8Array(32)),
    { entropy: crypto.getRandomValues(new Uint8Array(32)), identityContractNonce: 1n }
  )
  const fund = await sdk.documents.contestFundToJoin(document)
  return fund ? { indexName: fund.indexName, credits: BigInt(fund.credits) } : null
}

/** The network fees of a preorder and of `label`'s domain, priced offline from the DPNS contract. */
export async function readRegistrationFees(sdk: ConnectedSdk, label: string): Promise<{ preorder: bigint; domain: bigint }> {
  try {
    const contract = await sdk.contracts.fetch(DPNS_CONTRACT_ID)
    if (!contract) throw new Error('the DPNS contract could not be read')
    // getEvoSdk initialised this same glue; never compile the wasm a second time.
    const w = await import('@dashevo/wasm-sdk')
    const price = (type: string, fields: Record<string, { length: number }> = {}) =>
      BigInt(w.documentCreateCost(contract, type, { fields }, w.PlatformVersion.latest()).totalCredits.newValues)
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
  if (record?.domain) return { label, contestFund: null, fees: 0n }
  const [contestFund, fees] = await Promise.all([
    readContestFund(sdk, ownerId, label, normalizedLabel),
    readRegistrationFees(sdk, label),
  ])
  const preorderPaid = record?.preorderLanded === true || record?.preorder !== undefined
  return { label, contestFund, fees: (preorderPaid ? 0n : fees.preorder) + fees.domain }
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

  const fees = await readRegistrationFees(sdk, label)
  if (!record?.preorderLanded) {
    let replacesNonce: bigint | undefined
    if (record?.preorder) {
      const settled = await stateTransitionService.settleCreate(record.preorder)
      if (settled === null) return { state: 'pending', step: 'preorder' }
      if (settled === 'landed') {
        record.preorderLanded = true
        if (!saveRegistration(record)) return { state: 'pending', step: 'preorder' }
      } else if (settled === 'stalled') {
        // Refused for now with its nonce free: it may still land, so its receipt stays until a
        // replacement at the same nonce goes out (at most one of the two ever can).
        replacesNonce = record.preorder.nonce
      } else {
        delete record.preorder
        saveRegistration(record)
      }
    }
    // A preorder with this salt already on chain (its receipt lost or replaced) is the one to
    // use: the salted hash is unique, so another would only be refused, and charged.
    if (record && !record.preorderLanded) {
      let onChain: boolean
      try {
        onChain = await preorderOnChain(sdk, record)
      } catch (error) {
        if (record.preorder) return { state: 'pending', step: 'preorder', ...(replacesNonce !== undefined ? { stalled: true } : {}) }
        throw new DpnsNotSentError(error)
      }
      if (onChain) {
        record.preorderLanded = true
        if (!saveRegistration(record)) return { state: 'pending', step: 'preorder' }
      }
    }
    if (!record?.preorderLanded) {
      // Before paying the preorder: the deposit must be the approved one and the balance must
      // pay it with both fees, or the preorder would be paid for a domain that can't be.
      const contestFund = await approvedFund(sdk, input)
      await requireBalance(sdk, ownerId, creditsNeeded({ contestFund, fees: fees.preorder + fees.domain }))
      if (!record) {
        record = { ownerId, label, normalizedLabel, salt: newPreorderSalt() }
        save(record)
        // The salt is what makes the preorder usable: it must outlive this call before one is paid.
        await durable(input)
      }
      const preorder = await sendStep(record, 'preorder', { saltedDomainHash: saltedDomainHash(record.salt, normalizedLabel) }, { signingKey, replacesNonce })
      if (preorder === 'pending') return { state: 'pending', step: 'preorder' }
      record.preorderLanded = true
      // Landed, and its receipt is stored: a record that fails to say so is settled next time.
      if (!saveRegistration(record)) return { state: 'pending', step: 'preorder' }
    }
  }
  if (!record) throw new Error('unreachable: no registration record after the preorder')

  // The domain: the deposit read right before signing must be the approved one.
  const contestFund = await approvedFund(sdk, input)
  if (contestFund) {
    // Already a contender: a domain this browser sent and lost the receipt of (the app killed
    // right after the broadcast, storage partly cleared). Another would be refused, and charged.
    let joined: boolean
    try {
      joined = (await readContender(sdk, ownerId, normalizedLabel)).contender
    } catch (error) {
      throw new DpnsNotSentError(error)
    }
    if (joined) return finished({ state: 'joined-vote' })
  }
  await requireBalance(sdk, ownerId, creditsNeeded({ contestFund, fees: fees.domain }))
  const domain = await sendStep(record, 'domain', domainDocumentData(record.label, normalizedLabel, ownerId, record.salt), {
    signingKey,
    ...(contestFund ? { prefundedVotingBalance: contestFund } : {}),
  })
  if (domain === 'pending') return { state: 'pending', step: 'domain' }
  return finished(contestFund ? { state: 'joined-vote' } : { state: 'registered' })
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
async function approvedFund(sdk: ConnectedSdk, input: RegisterDpnsNameInput): Promise<ContestFund | null> {
  try {
    return approvedContestFund(input.label, input.contestFund, await readContestFund(sdk, input.ownerId, input.label, input.normalizedLabel))
  } catch (error) {
    throw new DpnsNotSentError(error)
  }
}
