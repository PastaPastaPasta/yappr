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
import { YAPPR_BLOG_CONTRACT_ID, YAPPR_CONTRACT_ID, YAPPR_STOREFRONT_CONTRACT_ID, blogIsV7, blogIsV9, storefrontIsV10, storefrontIsV6 } from '@/lib/constants'
import {
  authorDeletesLeaveHoles,
  contractIsModerated,
  contractTakesReports,
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
  /** True when the moderators resolve reports in place (social v10 and later, storefront v10, blog v9). */
  reportsResolved(): boolean
  /**
   * What a report on this contract can name: each target property of its
   * `report` type and the document type it refers to (social: a post or a
   * reply, and a profile through `about`; storefront v10: a store, a listing
   * or either review; blog v9: a blog, a post or a comment). Empty where the
   * registered cut takes no reports.
   */
  reportTargets(): readonly ReportTarget[]
  /** True when the contract counts each seated member's actions for the pot's action share. */
  countsActions(): boolean
}

/** One thing a report can name: the `report` property and the document type it refers to. */
export interface ReportTarget {
  readonly field: string
  readonly docType: string
}

// ---- storefront and blog, read off their committed JSON -------------------

interface DeclaredSchema {
  canBeDeleted?: boolean
  moderatorAbilities?: ModeratorAbilities
  properties?: Record<string, { refersTo?: { documentType?: string } }>
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

/** A declared contract as the registered cut sees it: only the document types that cut has. */
interface DeclaredView {
  schemas: Record<string, DeclaredSchema>
  declaration: ElectedModerationDeclaration | null
  deletable: readonly string[]
  targets: readonly ReportTarget[]
}

/** Pure: the targets a contract's `report` type names, each a property referring to another of its types. */
export function reportTargetsOf(schemas: Readonly<Record<string, DeclaredSchema>>): ReportTarget[] {
  return Object.entries(schemas.report?.properties ?? {})
    .flatMap(([field, property]) => (property.refersTo?.documentType ? [{ field, docType: property.refersTo.documentType }] : []))
}

/**
 * A contract described by its committed JSON, live only while `enabled()`
 * (its topology gate says the registered cut is the elected one, and the
 * build has an id for it). A type the committed file declares but the
 * registered cut may predate is named in `laterTypes` with its own gate
 * (storefront's and blog's `report`, new in storefront v10 and blog v9): off
 * its gate, every answer leaves it out, as the older registered cut does.
 */
function declaredContract(
  key: ModeratedContractKey,
  label: string,
  contractId: string,
  json: ContractJson,
  enabled: () => boolean,
  laterTypes: Readonly<Record<string, () => boolean>> = {}
): ModeratedContract {
  const moderation = json.config.moderation as DeclaredModeration | undefined
  const allSchemas = json.documentSchemas as Record<string, DeclaredSchema>
  const lists = Object.freeze(listsKeptOf(moderation))
  const on = () => contractId !== '' && enabled()
  // Frozen once per set of types the registered cut has: React effects depend
  // on the declaration, and a fresh object per call would re-run them on every
  // render.
  const views = new Map<string, DeclaredView>()
  const view = (): DeclaredView => {
    const present = Object.keys(allSchemas).filter((type) => laterTypes[type]?.() ?? true)
    const cacheKey = present.join(',')
    let found = views.get(cacheKey)
    if (!found) {
      const schemas = Object.fromEntries(present.map((type) => [type, allSchemas[type]]))
      const elected = moderation?.moderators
      const declared = elected
        ? { ...moderation, moderators: { ...elected, moderatedDocumentTypes: Object.fromEntries(Object.entries(elected.moderatedDocumentTypes).filter(([type]) => present.includes(type))) } }
        : moderation
      found = deepFreeze({
        schemas,
        declaration: electedDeclarationOf(declared),
        deletable: Object.entries(schemas).filter(([, schema]) => schema.moderatorAbilities?.delete === true).map(([name]) => name),
        targets: reportTargetsOf(schemas),
      })
      views.set(cacheKey, found)
    }
    return found
  }
  const abilities = (docType: string): ModeratorAbilities | null => (on() ? view().schemas[docType]?.moderatorAbilities ?? null : null)
  return {
    key,
    contractId,
    label,
    moderated: on,
    listsKept: () => (on() ? lists : []),
    elected: () => (on() ? view().declaration : null),
    deletableTypes: () => (on() ? view().deletable : []),
    keepsRecord: (docType) => {
      const declared = abilities(docType)
      return declared?.delete === true && declared.deleteKeepsRecord !== false
    },
    settledDeletionFor: (docType) => settledRuleOf(abilities(docType)),
    deleteWindowSeconds: (docType) => abilities(docType)?.deleteWithin ?? null,
    authorsDelete: (docType) => allSchemas[docType]?.canBeDeleted !== false,
    reportsResolved: () => (abilities('report')?.changeFields?.length ?? 0) > 0,
    reportTargets: () => (on() ? view().targets : []),
    // Every elected 5.0 contract counts its seated members' actions.
    countsActions: () => on() && view().declaration !== null,
  }
}

// ---- social, as the configured topology declares it ------------------------

/** A social report names a post or a reply (and a profile through `about`, see lib/reports). */
const SOCIAL_REPORT_TARGETS: readonly ReportTarget[] = Object.freeze([
  Object.freeze({ field: 'postId', docType: 'post' }),
  Object.freeze({ field: 'replyId', docType: 'reply' }),
])

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
  reportTargets: () => (contractTakesReports() ? SOCIAL_REPORT_TARGETS : []),
  countsActions: () => isV11() && electedModeration() !== null,
}

const STOREFRONT = declaredContract('storefront', 'Storefront', YAPPR_STOREFRONT_CONTRACT_ID, storefrontContract, storefrontIsV6, { report: storefrontIsV10 })
const BLOG = declaredContract('blog', 'Blogs', YAPPR_BLOG_CONTRACT_ID, blogContract, blogIsV7, { report: blogIsV9 })

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
