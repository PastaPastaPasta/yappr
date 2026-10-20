import type { ActionFeeDeclaration, DocumentAction, SettledDeletionRule } from '@/lib/contract-topology'

/**
 * What the app reads off a REGISTERED contract where it may differ from the
 * committed template the build bundles: a deployment registered from an
 * earlier cut of the same file keeps its own values. /staging's social v17,
 * blog v9 and storefront v10, and sakura's (/devnet), were registered before
 * D39 and D41, so they still declare a week's single-moderator window, three
 * settled approvals, the owner protected and the earlier action fees, while
 * the files say a day, two, unprotected and lower fees.
 *
 * The SDK service records every contract it seeds or preloads, before the app
 * reads or writes anything, and the moderation service records the contract
 * each team read fetches. Until a contract is recorded every reader answers
 * `undefined`, and its caller uses the template.
 *
 * Pure apart from the session map. It imports types only, so mocked topology
 * modules in tests cannot break it.
 */

interface RegisteredType {
  /** The raw `actionFees` the type declares, or undefined when it declares none. */
  readonly actionFees: RawActionFees | undefined
  /** `moderatorAbilities.deleteWithin` in seconds, or null when it declares none. */
  readonly deleteWithin: number | null
  /** The settled-deletion rule (`deleteWithin` + `deleteSettled`), or null. */
  readonly settled: SettledDeletionRule | null
}

interface RegisteredContract {
  /** Per document type; null when the contract's schemas could not be read. */
  readonly types: ReadonlyMap<string, RegisteredType> | null
  /** The elected declaration's `ownerProtected`; null off an elected declaration or when unreadable. */
  readonly ownerProtected: boolean | null
}

type RawActionFees = { pricing?: unknown } & Partial<Record<DocumentAction, { owner?: unknown; moderators?: unknown }>>

const known = new Map<string, RegisteredContract>()

/** The refresh of recorded contracts in flight (the SDK's bundle revalidation), settled or not. */
let refreshing: Promise<boolean> = Promise.resolve(true)

/** How long a write waits for a refresh in flight before it reads the records as they stand. */
const REFRESH_WAIT_MS = 10_000

/**
 * Registers a refresh in flight: the SDK seeds the bundled snapshot at once
 * and checks it against the chain afterwards, refetching what is stale. It
 * resolves true once the records are proved current, false when the check
 * failed or could not be made.
 */
export function trackRegisteredRefresh(refresh: Promise<boolean>): void {
  refreshing = refresh.catch(() => false)
}

/**
 * Whether the recorded contracts were proved current: waits for the refresh
 * in flight, at most {@link REFRESH_WAIT_MS}. A priced write awaits it before
 * reading the fee it agrees to; on false (the check failed, could not be made
 * or is still running) it reads its contract from the chain first, so an
 * unverified snapshot is never agreed to (40133). Reads never wait.
 */
export async function registeredContractsSettled(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const verified = await Promise.race([refreshing, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), REFRESH_WAIT_MS) })])
  clearTimeout(timer)
  return verified
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
/** A wasm schema carries integers as bigints; JSON as numbers. */
const integer = (value: unknown): number | null => (typeof value === 'bigint' || typeof value === 'number' ? Number(value) : null)

/** Credits as a bigint, keeping a wasm bigint exact. */
const credits = (value: unknown): bigint => (typeof value === 'bigint' ? value : BigInt(integer(value) ?? 0))

/**
 * Pure: the settled-deletion rule moderator abilities declare (`deleteWithin` +
 * `deleteSettled`), or null. Reads the committed files' numbers and a wasm
 * schema's bigints alike, so the template and the registered contract share it.
 */
export function settledRuleOf(abilities: { delete?: unknown; deleteWithin?: unknown; deleteSettled?: unknown } | null | undefined): SettledDeletionRule | null {
  const windowSeconds = integer(abilities?.deleteWithin)
  const settled = abilities?.deleteSettled
  if (abilities?.delete !== true || windowSeconds === null || !isObject(settled)) return null
  return { windowSeconds, leaderRequired: settled.leader === true, approvals: integer(settled.approvals) ?? 1 }
}

function registeredType(schema: Record<string, unknown>): RegisteredType {
  const abilities = isObject(schema.moderatorAbilities) ? schema.moderatorAbilities : null
  return {
    actionFees: isObject(schema.actionFees) ? (schema.actionFees as RawActionFees) : undefined,
    deleteWithin: integer(abilities?.deleteWithin),
    settled: settledRuleOf(abilities),
  }
}

/**
 * Pure: the declarations of a fetched contract (`schemas` and `config`, as the
 * wasm `DataContract` exposes them), or null when neither can be read.
 */
export function registeredContractOf(contract: { schemas?: unknown; config?: unknown }): RegisteredContract | null {
  const schemas = contract.schemas
  const types = isObject(schemas)
    ? new Map(Object.entries(schemas).filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1])).map(([name, schema]) => [name, registeredType(schema)]))
    : null
  const moderators = isObject(contract.config) && isObject(contract.config.moderation) ? contract.config.moderation.moderators : undefined
  const ownerProtected = isObject(moderators) && moderators.$type === 'elected' ? moderators.ownerProtected === true : null
  return types === null && ownerProtected === null ? null : { types, ownerProtected }
}

/**
 * Records what `contract` (registered as `contractId`) declares, replacing
 * an earlier record. A contract that declares nothing readable is forgotten,
 * so the template answers for it. Never throws: a getter that fails keeps the
 * earlier record, if any, and costs the caller's read nothing.
 */
export function rememberRegisteredContract(contractId: string, contract: { schemas?: unknown; config?: unknown }): void {
  let record: RegisteredContract | null
  try {
    record = registeredContractOf(contract)
  } catch {
    return
  }
  if (record) known.set(contractId, record)
  else known.delete(contractId)
}

function registeredTypeOf(contractId: string, docType: string): RegisteredType | undefined {
  return known.get(contractId)?.types?.get(docType)
}

/** The registered action fee for `docType`/`action`: null when it charges nothing, undefined when unknown. */
export function registeredActionFee(contractId: string, docType: string, action: DocumentAction): ActionFeeDeclaration | null | undefined {
  const type = registeredTypeOf(contractId, docType)
  if (!type) return undefined
  const fee = type.actionFees?.[action]
  if (!fee) return null
  return {
    owner: credits(fee.owner),
    moderators: credits(fee.moderators),
    pricing: type.actionFees?.pricing === 'fixed' ? 'fixed' : 'feeMultiplier',
  }
}

/** The registered single-moderator window of `docType` in seconds: null when unlimited, undefined when unknown. */
export function registeredDeleteWindow(contractId: string, docType: string): number | null | undefined {
  return registeredTypeOf(contractId, docType)?.deleteWithin
}

/** The registered settled-deletion rule of `docType`: null when it has none, undefined when unknown. */
export function registeredSettledRule(contractId: string, docType: string): SettledDeletionRule | null | undefined {
  return registeredTypeOf(contractId, docType)?.settled
}

/** A registered value when the contract has been recorded (`undefined` means unknown), else the template's. */
export function registeredOr<T>(registered: T | undefined, template: () => T): T {
  return registered === undefined ? template() : registered
}

/** Whether the registered elected declaration protects the owner, or undefined when unknown. */
export function registeredOwnerProtected(contractId: string): boolean | undefined {
  return known.get(contractId)?.ownerProtected ?? undefined
}
