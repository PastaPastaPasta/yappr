import type { ActionFeeDeclaration, DocumentAction, SettledDeletionRule } from '@/lib/contract-topology'

/**
 * What the app reads off a REGISTERED contract where it may differ from the
 * committed template the build bundles: a deployment registered from an
 * earlier cut of the same file keeps its own values. Sakura's (/devnet)
 * social v17, blog v9 and storefront v10 (like the retired staging
 * rehearsal's) were registered before D39 and D41, so they still declare a week's single-moderator window, three
 * settled approvals, the owner protected and the earlier action fees, while
 * the files say a day, two, unprotected and lower fees. The same contracts
 * key `reply.repliesOf` on `rootPostId`, where the release file keys it on
 * `live` first, so which index shape the reads must match is read here too.
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
  /** Each declared index's first property, by index name. */
  readonly indexLeads: ReadonlyMap<string, string>
}

interface RegisteredContract {
  /** Per document type; null when the contract's schemas could not be read. */
  readonly types: ReadonlyMap<string, RegisteredType> | null
  /** The elected declaration's `ownerProtected`; null off an elected declaration or when unreadable. */
  readonly ownerProtected: boolean | null
}

type RawActionFees = { pricing?: unknown } & Partial<Record<DocumentAction, { owner?: unknown; moderators?: unknown }>>

const known = new Map<string, RegisteredContract>()

/**
 * The contracts whose record came from the chain, or from a bundled snapshot
 * the chain has since been proved to match. A bundled seed is recorded at once
 * but stays unverified until the SDK's revalidation proves it current.
 */
const verified = new Set<string>()

/** The refresh of recorded contracts in flight (the SDK's bundle revalidation). */
let refreshing: Promise<unknown> = Promise.resolve()

/** How long a priced write waits for a refresh in flight before it reads its contract itself. */
const REFRESH_WAIT_MS = 10_000

/** Registers a refresh in flight: the SDK seeds the bundled snapshot at once and checks it against the chain afterwards. */
export function trackRegisteredRefresh(refresh: Promise<unknown>): void {
  refreshing = refresh.catch(() => undefined)
}

/** Marks recorded contracts as proved current (a bundled seed whose version the chain confirmed). */
export function markRegisteredVerified(contractIds: readonly string[]): void {
  for (const id of contractIds) if (known.has(id)) verified.add(id)
}

/**
 * Makes sure `contractId`'s record is proved against the chain before a
 * priced write agrees to its fee: an unverified record (a bundled seed not yet
 * or never confirmed) or a missing one (a failed preload) first waits, at most
 * {@link REFRESH_WAIT_MS}, for the refresh in flight, then is read with
 * `fetch` and recorded. Throws when the contract cannot be read, so the write
 * fails before signing rather than agreeing to an unproved fee (40133).
 */
export async function ensureRegisteredContract(contractId: string, fetch: () => Promise<{ schemas?: unknown; config?: unknown } | null | undefined>): Promise<void> {
  if (verified.has(contractId)) return
  // Only a bundled seed can be proved by the revalidation; a missing record is read at once.
  if (known.has(contractId)) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([refreshing, new Promise<void>((resolve) => { timer = setTimeout(resolve, REFRESH_WAIT_MS) })])
    clearTimeout(timer)
    if (verified.has(contractId)) return
  }
  let contract: { schemas?: unknown; config?: unknown } | null | undefined
  try {
    contract = await fetch()
  } catch {
    contract = null
  }
  if (contract) rememberRegisteredContract(contractId, contract)
  // Nothing was signed or sent: worded so it is never mistaken for a write whose outcome is unknown.
  if (!verified.has(contractId)) throw new Error(FEE_CHECK_FAILED)
}

/** What a priced write reports when it could not confirm the fee with the network; nothing was sent. */
export const FEE_CHECK_FAILED = 'Couldn\'t check the fee with the network. Nothing was sent, so try again.'

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

/**
 * Pure: each index's first property, by index name, off a schema's `indices`
 * (`[{ name, properties: [{ <property>: 'asc' }, ...] }]` in the committed
 * files and the wasm schema alike).
 */
export function indexLeadsOf(indices: unknown): Map<string, string> {
  const leads = new Map<string, string>()
  if (!Array.isArray(indices)) return leads
  for (const index of indices) {
    if (!isObject(index) || typeof index.name !== 'string' || !Array.isArray(index.properties)) continue
    const first: unknown = index.properties[0]
    const property = isObject(first) ? Object.keys(first)[0] : undefined
    if (property) leads.set(index.name, property)
  }
  return leads
}

function registeredType(schema: Record<string, unknown>): RegisteredType {
  const abilities = isObject(schema.moderatorAbilities) ? schema.moderatorAbilities : null
  return {
    actionFees: isObject(schema.actionFees) ? (schema.actionFees as RawActionFees) : undefined,
    deleteWithin: integer(abilities?.deleteWithin),
    settled: settledRuleOf(abilities),
    indexLeads: indexLeadsOf(schema.indices),
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
export function rememberRegisteredContract(contractId: string, contract: { schemas?: unknown; config?: unknown }, { seed = false }: { seed?: boolean } = {}): void {
  let record: RegisteredContract | null
  try {
    record = registeredContractOf(contract)
  } catch {
    return
  }
  if (record) {
    // A chain read this session is at least as new as a build-time snapshot: a re-seed (an SDK rebuild) never replaces it.
    if (seed && verified.has(contractId)) return
    known.set(contractId, record)
    // A bundled seed is unproved until revalidation; a chain read is proved.
    if (seed) verified.delete(contractId)
    else verified.add(contractId)
  } else {
    known.delete(contractId)
    verified.delete(contractId)
  }
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

/** The registered first property of `docType`'s `index`: null when the type has no such index, undefined when unknown. */
export function registeredIndexLead(contractId: string, docType: string, index: string): string | null | undefined {
  const type = registeredTypeOf(contractId, docType)
  return type ? type.indexLeads.get(index) ?? null : undefined
}

/** A registered value when the contract has been recorded (`undefined` means unknown), else the template's. */
export function registeredOr<T>(registered: T | undefined, template: () => T): T {
  return registered === undefined ? template() : registered
}

/** Whether the registered elected declaration protects the owner, or undefined when unknown. */
export function registeredOwnerProtected(contractId: string): boolean | undefined {
  return known.get(contractId)?.ownerProtected ?? undefined
}
