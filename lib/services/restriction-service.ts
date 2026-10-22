import { YAPPR_BLOG_CONTRACT_ID, YAPPR_CONTRACT_ID, blogAuthorsCanBeRestricted } from '@/lib/constants'
import { authorsCanBeRestricted } from '@/lib/contract-topology'
import { logger } from '@/lib/logger'
import { getEvoSdk } from './evo-sdk-service'
import { identifierToBase58, normalizeSDKResponse } from './sdk-helpers'

/**
 * Account restrictions ("restrict, never ban"; docs/SOCIAL_V18.md
 * "Restriction"). Social v18 and blog v10 each carry a moderator-only
 * `restriction` document per restricted author (`byTarget [target]` unique):
 * `state` 1 while it is in force, 2 once lifted, with the charter reason the
 * team gave. While one is in force the contract makes the author's new posts
 * and replies (blog posts on blog v10) carry `live: 2`, which yap.pr does not
 * list, and refuses `live: 1`.
 *
 * An author's own standing is read once per session and kept; a write the
 * contract refused re-reads it ({@link RestrictionService.refresh}).
 */

export type RestrictionContract = 'social' | 'blog'

export interface Restriction {
  /** The restriction document's id. */
  id: string
  /** The restricted (or once-restricted) identity. */
  target: string
  /** 1 in force, 2 lifted. */
  state: 1 | 2
  /** The charter reason (1–63) the team gave. */
  reason: number | null
  /** The member who last placed or lifted it, and when (ms), when stamped. */
  moderatedBy: string | null
  moderatedAt: number | null
  createdAt: number | null
}

/** Reads a stored restriction document; null when it is not one. */
export function toRestriction(doc: Record<string, unknown>): Restriction | null {
  const id = identifierToBase58(doc.$id ?? doc.id)
  const target = identifierToBase58(doc.target)
  const state = Number(doc.state)
  if (!id || !target || (state !== 1 && state !== 2)) return null
  const time = (value: unknown): number | null => {
    const ms = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : NaN
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }
  const reason = Number(doc.reason)
  return {
    id,
    target,
    state,
    reason: Number.isInteger(reason) && reason > 0 ? reason : null,
    moderatedBy: identifierToBase58(doc.$moderatedBy) ?? null,
    moderatedAt: time(doc.$moderatedAt),
    createdAt: time(doc.$createdAt),
  }
}

class RestrictionService {
  private readonly standing = new Map<string, Promise<Restriction | null>>()

  constructor(private readonly contract: RestrictionContract) {}

  /** True when this build's cut of the contract restricts authors. */
  supported(): boolean {
    return this.contract === 'social' ? authorsCanBeRestricted() : blogAuthorsCanBeRestricted()
  }

  private contractId(): string {
    return this.contract === 'social' ? YAPPR_CONTRACT_ID : YAPPR_BLOG_CONTRACT_ID
  }

  /** The identity's restriction document (in force or lifted), or null when there is none. Read through `restriction.byTarget`. */
  async read(identityId: string): Promise<Restriction | null> {
    if (!this.supported() || !identityId) return null
    const sdk = await getEvoSdk()
    const response = await sdk.documents.query({
      dataContractId: this.contractId(),
      documentTypeName: 'restriction',
      where: [['target', '==', identityId]],
      limit: 1,
    })
    const [doc] = normalizeSDKResponse(response)
    return doc ? toRestriction(doc) : null
  }

  /** The identity's restriction, read once per session (see {@link refresh}). */
  get(identityId: string): Promise<Restriction | null> {
    if (!this.supported() || !identityId) return Promise.resolve(null)
    let pending = this.standing.get(identityId)
    if (!pending) {
      pending = this.read(identityId).catch((error: unknown) => {
        this.standing.delete(identityId)
        throw error
      })
      this.standing.set(identityId, pending)
    }
    return pending
  }

  /** True while the identity has a restriction in force. */
  async isRestricted(identityId: string): Promise<boolean> {
    return (await this.get(identityId))?.state === 1
  }

  /** Forget the cached standing and read it again (after a refused write, or a moderator's change). */
  refresh(identityId: string): Promise<Restriction | null> {
    this.standing.delete(identityId)
    return this.get(identityId).catch((error: unknown) => {
      logger.warn(`restrictions(${this.contract}): could not re-read the standing`, error)
      return null
    })
  }

  /** Drop every cached standing (sign-out, account switch). */
  clear(): void {
    this.standing.clear()
  }
}

const SERVICES: Record<RestrictionContract, RestrictionService> = {
  social: new RestrictionService('social'),
  blog: new RestrictionService('blog'),
}

export type { RestrictionService }

/** The restriction service of one contract. */
export function restrictionServiceFor(contract: RestrictionContract): RestrictionService {
  return SERVICES[contract]
}

/** Social v18's restrictions. */
export const restrictionService = SERVICES.social
