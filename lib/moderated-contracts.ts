/**
 * The contracts Yappr moderates, each described the same way, so one
 * moderation service, one set of hooks and one set of moderator screens serve
 * all three:
 *
 * - `social`: posts, replies, reports and the profile extension. Its shape
 *   moves with `NEXT_PUBLIC_CONTRACT_TOPOLOGY`, so every answer delegates to
 *   `lib/contract-topology`;
 * - `storefront`: stores, listings and both kinds of review;
 * - `blog`: blogs, blog posts and comments.
 *
 * Storefront (v6 and later: the mainnet re-cut; v7 only re-encodes variants)
 * and blog (v7 and later) declare ELECTED moderation
 * of their own, read here off the committed contract JSON
 * (contracts/yappr-storefront-contract.json, contracts/yappr-blog-contract.json):
 * a banlist, suspensions and warnings, their own fee pots, their own charter
 * election and seated team. A ban on one contract bars nothing on another.
 * The REGISTERED interim may differ from the file's (testnet registers
 * `notYetUsable`), so who moderates and whether a type is open are always
 * read from the chain (`moderationService`); only the shape comes from here.
 */
import blogContract from '@/contracts/yappr-blog-contract.json'
import storefrontContract from '@/contracts/yappr-storefront-contract.json'
import { YAPPR_BLOG_CONTRACT_ID, YAPPR_CONTRACT_ID, YAPPR_STOREFRONT_CONTRACT_ID, blogIsV7, storefrontIsV6 } from '@/lib/constants'
import {
  authorDeletesLeaveHoles,
  contractIsModerated,
  electedModeration,
  isV11,
  moderationListsKept,
  moderatorDeletableTypes,
  moderatorDeleteWindowSeconds,
  moderatorDeletionKeepsRecord,
  reportsAreResolved,
  settledDeletionFor,
  type ElectedModerationDeclaration,
  type ModerationAbility,
  type ModerationList,
  type ModeratorAbilities,
  type SettledDeletionRule,
} from '@/lib/contract-topology'

export const MODERATED_CONTRACTS = ['social', 'storefront', 'blog'] as const
export type ModeratedContractKey = (typeof MODERATED_CONTRACTS)[number]

/** What the moderators of one contract can do, as its registered cut declares. */
export interface ModeratedContract {
  readonly key: ModeratedContractKey
  /** The contract's id in this build; empty when the feature is switched off. */
  readonly contractId: string
  /** How moderator screens name the contract ("Social", "Storefront", "Blogs"). */
  readonly label: string
  /** True when this build talks to a cut of the contract that declares moderation. */
  moderated(): boolean
  /** The lists the contract keeps; empty off a moderated cut. */
  listsKept(): readonly ModerationList[]
  /** The elected declaration, or null when the contract is not elected (or not moderated). */
  elected(): ElectedModerationDeclaration | null
  /** The document types the moderators may delete. */
  deletableTypes(): readonly string[]
  /** True when a moderator's deletion of `docType` leaves a removal record (and can be restored). */
  keepsRecord(docType: string): boolean
  /** How a settled `docType` is deleted, or null when one moderator deletes it at any age. */
  settledDeletionFor(docType: string): SettledDeletionRule | null
  /** Seconds after a `docType`'s last change in which one moderator deletes it alone; null = no limit. */
  deleteWindowSeconds(docType: string): number | null
  /** True when the author of a `docType` can delete it themselves, so a missing one may be their own delete. */
  authorsDelete(docType: string): boolean
  /** True when the moderators resolve reports in place (social v10 and later). */
  reportsResolved(): boolean
  /** True when the contract counts each seated member's actions for the pot's action share. */
  countsActions(): boolean
}

// ---- storefront and blog, read off their committed JSON -------------------

interface DeclaredSchema {
  canBeDeleted?: boolean
  moderatorAbilities?: ModeratorAbilities
}

interface DeclaredModeration {
  banlist?: boolean
  suspensions?: boolean
  warnings?: boolean
  moderators?: {
    $type: string
    joinWindow: number
    voteWindow: number
    seatContestable: boolean
    challengeCoolDown?: number
    electionDelay?: number
    maxAddedModerators?: number
    moderatedDocumentTypes: Record<string, ModerationAbility[]>
    interim: { $type: ElectedModerationDeclaration['interim'] }
    ownerProtected?: boolean
  }
}

interface ContractJson {
  config: { moderation?: unknown }
  documentSchemas: unknown
}

/** Pure: the lists a `config.moderation` keeps. */
export function listsKeptOf(moderation: DeclaredModeration | undefined): ModerationList[] {
  if (!moderation) return []
  return (['banlist', 'suspensions', 'warnings'] as const).filter((list) => moderation[list] === true)
}

/** Pure: the elected declaration a `config.moderation` makes, or null when its moderators are not elected. */
export function electedDeclarationOf(moderation: DeclaredModeration | undefined): ElectedModerationDeclaration | null {
  const elected = moderation?.moderators
  if (elected?.$type !== 'elected') return null
  return {
    joinWindowSeconds: elected.joinWindow,
    voteWindowSeconds: elected.voteWindow,
    seatContestable: elected.seatContestable,
    challengeCoolDownSeconds: elected.challengeCoolDown ?? null,
    electionDelaySeconds: elected.electionDelay ?? null,
    maxAddedModerators: elected.maxAddedModerators ?? 0,
    moderatedDocumentTypes: elected.moderatedDocumentTypes,
    interim: elected.interim.$type,
    ownerProtected: elected.ownerProtected === true,
  }
}

/** Pure: the settled-deletion rule moderator abilities declare (`deleteWithin` + `deleteSettled`), or null. */
export function settledRuleOf(abilities: ModeratorAbilities | null | undefined): SettledDeletionRule | null {
  if (!abilities?.delete || abilities.deleteWithin === undefined || !abilities.deleteSettled) return null
  return {
    windowSeconds: abilities.deleteWithin,
    leaderRequired: abilities.deleteSettled.leader === true,
    approvals: abilities.deleteSettled.approvals ?? 1,
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * A contract described by its committed JSON, live only while `enabled()`
 * (its topology gate says the registered cut is the elected one, and the
 * build has an id for it).
 */
function declaredContract(
  key: ModeratedContractKey,
  label: string,
  contractId: string,
  json: ContractJson,
  enabled: () => boolean
): ModeratedContract {
  const moderation = json.config.moderation as DeclaredModeration | undefined
  const schemas = json.documentSchemas as Record<string, DeclaredSchema>
  // Frozen once: React effects depend on the declaration, and a fresh object
  // per call would re-run them on every render.
  const declaration = deepFreeze(electedDeclarationOf(moderation))
  const lists = Object.freeze(listsKeptOf(moderation))
  const deletable = Object.freeze(Object.entries(schemas).filter(([, schema]) => schema.moderatorAbilities?.delete === true).map(([name]) => name))
  const on = () => contractId !== '' && enabled()
  const abilities = (docType: string): ModeratorAbilities | null => (on() ? schemas[docType]?.moderatorAbilities ?? null : null)
  return {
    key,
    contractId,
    label,
    moderated: on,
    listsKept: () => (on() ? lists : []),
    elected: () => (on() ? declaration : null),
    deletableTypes: () => (on() ? deletable : []),
    keepsRecord: (docType) => {
      const declared = abilities(docType)
      return declared?.delete === true && declared.deleteKeepsRecord !== false
    },
    settledDeletionFor: (docType) => settledRuleOf(abilities(docType)),
    deleteWindowSeconds: (docType) => abilities(docType)?.deleteWithin ?? null,
    authorsDelete: (docType) => schemas[docType]?.canBeDeleted !== false,
    reportsResolved: () => false,
    // Every elected 5.0 contract counts its seated members' actions.
    countsActions: () => on() && declaration !== null,
  }
}

// ---- social, as the configured topology declares it ------------------------

const SOCIAL: ModeratedContract = {
  key: 'social',
  contractId: YAPPR_CONTRACT_ID,
  label: 'Social',
  moderated: () => contractIsModerated(),
  listsKept: () => moderationListsKept(),
  elected: () => electedModeration(),
  deletableTypes: () => moderatorDeletableTypes(),
  keepsRecord: (docType) => moderatorDeletionKeepsRecord(docType),
  settledDeletionFor: (docType) => settledDeletionFor(docType),
  deleteWindowSeconds: (docType) => moderatorDeleteWindowSeconds(docType),
  authorsDelete: () => authorDeletesLeaveHoles(),
  reportsResolved: () => reportsAreResolved(),
  countsActions: () => isV11() && electedModeration() !== null,
}

const STOREFRONT = declaredContract('storefront', 'Storefront', YAPPR_STOREFRONT_CONTRACT_ID, storefrontContract, storefrontIsV6)
const BLOG = declaredContract('blog', 'Blogs', YAPPR_BLOG_CONTRACT_ID, blogContract, blogIsV7)

const CONTRACTS: Readonly<Record<ModeratedContractKey, ModeratedContract>> = { social: SOCIAL, storefront: STOREFRONT, blog: BLOG }

export function moderatedContract(key: ModeratedContractKey): ModeratedContract {
  return CONTRACTS[key]
}

/** How a moderated document type is named to people ("listing", not "storeItem"). */
const DOCUMENT_NOUNS: Readonly<Record<string, string>> = {
  store: 'store',
  storeItem: 'listing',
  storeReview: 'review',
  itemReview: 'review',
  blog: 'blog',
  blogPost: 'blog post',
  blogComment: 'comment',
  yapprProfile: 'profile',
}

/** `docType` as moderators read it; social's `post`, `reply` and `report` are their own names. */
export function documentNoun(docType: string): string {
  return DOCUMENT_NOUNS[docType] ?? docType
}
