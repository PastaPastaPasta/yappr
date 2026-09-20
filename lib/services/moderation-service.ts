import { logger } from '@/lib/logger';
import type { EvoSDK, Identity, IdentitySigner } from '@dashevo/evo-sdk';
import type { ContractModerationReason, ContractModerationStatus } from '@dashevo/wasm-sdk';
import { YAPPR_CONTRACT_ID, keyNetwork } from '@/lib/constants';
import { contractIsModerated, moderatorDeletableTypes, type TargetKind } from '@/lib/contract-topology';
import { matchIdentityKey } from '@/lib/crypto/keys';
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys';
import { extractErrorMessage } from '@/lib/error-utils';
import { getEvoSdk } from './evo-sdk-service';
import { identifierToBase58 } from './sdk-helpers';
import { signerService } from './signer-service';

/**
 * Contract moderation on the social contract (Platform 4.2.0-beta.3,
 * protocol version 14; docs/SOCIAL_V8.md):
 *
 * - the contract keeps a **banlist** and a **suspension list**; an identity
 *   on either has every document transition against the contract refused,
 *   paid (41107 banned, 41108 suspended);
 * - `post` and `reply` are `canBeDeletedByModerators`: a moderator deletes
 *   the document outright, leaving a **removal record** (owner, moderator,
 *   reason, block time) that nothing ever deletes; the document id can never
 *   be created again;
 * - `post.create`/`reply.create` charge an action fee into the contract's
 *   **moderators pot**, which any member of the moderation team pays out to
 *   the whole team with one claim per epoch (41111 on a second).
 *
 * Every moderation transition is signed by the contract owner or an
 * appointed moderator with a CRITICAL authentication key WITHOUT contract
 * bounds, under the signer's contract-scoped nonce. Reads are proved.
 *
 * Wraps `sdk.contracts.{banUser, unbanUser, suspendUser, unsuspendUser,
 * moderatorDeleteDocument, moderationStatus, moderationEntries,
 * documentRemovals, feePots, claimFees}`. Off a moderated topology every
 * write refuses locally and every read answers "nothing".
 */

export interface ModerationResult {
  success: boolean;
  error?: string;
  errorCode?: 'NOT_MODERATED' | 'NOT_MODERATOR' | 'NEEDS_CRITICAL_KEY' | 'INVALID_KEY' | 'ALREADY_CLAIMED' | 'NOTHING_TO_CLAIM' | 'NETWORK_ERROR';
}

/** One identity's standing on the contract's lists, as the chain proves it. */
export interface ModerationStanding {
  banned: boolean;
  banReason: string | null;
  /** Block time (ms) the suspension lapses, or null when not suspended. */
  suspendedUntil: number | null;
  suspensionReason: string | null;
}

/** One banlist or suspension-list entry. */
export interface ModerationEntry {
  identityId: string;
  reason: string;
  /** Suspension list only: the block time (ms) the suspension lapses. */
  until?: number;
}

/** The record a moderator's deletion left under the contract. */
export interface DocumentRemoval {
  documentId: string;
  documentOwnerId: string;
  moderatorId: string;
  reason: string;
  /** Block time (ms) of the removing block. */
  removedAt: number;
}

export interface FeePotState {
  credits: bigint;
  lastClaimEpoch: number | null;
  lastClaimantId: string | null;
}

/** Who may moderate the contract: its owner, plus any appointed identities. */
export interface ModerationTeam {
  ownerId: string;
  /** Appointed moderators (empty when only the owner moderates). */
  appointed: string[];
}

/** The moderating identity and a signer holding its CRITICAL key. */
interface ModeratorAuth {
  identity: Identity;
  signer: IdentitySigner;
}

const NO_STANDING: ModerationStanding = { banned: false, banReason: null, suspendedUntil: null, suspensionReason: null };

const reasonText = (reason: ContractModerationReason | undefined): string | null =>
  reason === undefined ? null : reason.text;

/** A `documentRemovals` entry as the app models it — both removal reads decode it identically. */
type RemovalEntry = Awaited<ReturnType<EvoSDK['contracts']['documentRemovals']>>['removals'][number];

const toRemoval = (entry: RemovalEntry): DocumentRemoval => ({
  documentId: entry.documentId,
  documentOwnerId: entry.documentOwnerId,
  moderatorId: entry.moderatorId,
  reason: entry.reason.text,
  removedAt: Number(entry.removedAt),
});

class ModerationService {
  /** The in-flight or resolved team fetch: a feed of cards asks once, not once per card. */
  private teamPromise: Promise<ModerationTeam> | null = null;
  private standingCache = new Map<string, { standing: ModerationStanding; at: number }>();
  /** Standing rarely changes; a page of cards must not re-query it per card. */
  private static readonly STANDING_TTL_MS = 60_000;

  // ---- Who moderates ------------------------------------------------------

  /**
   * The contract's moderation team, from the contract itself (cached for the
   * session: the set only changes by a contract update). Null when the
   * topology declares no moderation.
   */
  async getTeam(): Promise<ModerationTeam | null> {
    if (!contractIsModerated()) return null;
    if (!this.teamPromise) {
      this.teamPromise = (async () => {
        const sdk = await getEvoSdk();
        const contract = await sdk.contracts.fetch(YAPPR_CONTRACT_ID);
        if (!contract) throw new Error('Social contract not found');
        const moderators = contract.config.moderation?.moderators;
        const appointed = moderators && moderators.$type === 'appointedModerators'
          ? moderators.identities.map((id) => identifierToBase58(id) ?? String(id))
          : [];
        return { ownerId: contract.ownerId.toBase58(), appointed };
      })();
      // A failed fetch must not pin "not a moderator" for the session.
      this.teamPromise.catch(() => { this.teamPromise = null; });
    }
    return this.teamPromise;
  }

  /** True when `identityId` is the contract owner or an appointed moderator. */
  async isModerator(identityId: string | null | undefined): Promise<boolean> {
    if (!identityId) return false;
    try {
      const team = await this.getTeam();
      return team !== null && (team.ownerId === identityId || team.appointed.includes(identityId));
    } catch (error) {
      logger.warn('moderationService: could not resolve the moderation team', error);
      return false;
    }
  }

  /** The document types a moderator may remove (`post`, `reply` on v8). */
  canRemove(kind: TargetKind): boolean {
    return moderatorDeletableTypes().includes(kind);
  }

  // ---- Reads --------------------------------------------------------------

  /**
   * An identity's standing on both lists. Off a moderated topology, or when
   * the read fails, answers "in good standing" so a transient fault never
   * paints a user as banned; a WRITE failure carries its own 41107/41108.
   */
  async getStanding(identityId: string, { fresh = false } = {}): Promise<ModerationStanding> {
    if (!contractIsModerated()) return NO_STANDING;
    const cached = this.standingCache.get(identityId);
    if (!fresh && cached && Date.now() - cached.at < ModerationService.STANDING_TTL_MS) return cached.standing;
    try {
      const sdk = await getEvoSdk();
      const status: ContractModerationStatus = await sdk.contracts.moderationStatus({
        contractId: YAPPR_CONTRACT_ID,
        identityId,
        lists: ['banlist', 'suspensions'],
      });
      const standing: ModerationStanding = {
        banned: status.banned === true,
        banReason: reasonText(status.banReason),
        suspendedUntil: status.suspendedUntil === undefined ? null : Number(status.suspendedUntil),
        suspensionReason: reasonText(status.suspensionReason),
      };
      this.standingCache.set(identityId, { standing, at: Date.now() });
      return standing;
    } catch (error) {
      logger.warn('moderationService: moderation status read failed', error);
      return NO_STANDING;
    }
  }

  /** One page of the banlist or the suspension list, in identity id order. */
  async listEntries(list: 'banlist' | 'suspensions', startAfter?: string): Promise<{ entries: ModerationEntry[]; nextStartAfter?: string }> {
    if (!contractIsModerated()) return { entries: [] };
    const sdk = await getEvoSdk();
    const page = await sdk.contracts.moderationEntries({ contractId: YAPPR_CONTRACT_ID, list, startAfter, limit: 100 });
    return {
      entries: page.entries.map((entry) => ({
        identityId: entry.identityId,
        reason: entry.reason.text,
        ...(entry.until === undefined ? {} : { until: Number(entry.until) }),
      })),
      nextStartAfter: page.nextStartAfter,
    };
  }

  /**
   * The removal records of specific documents (at most 100 ids). A document
   * with no record — never removed — is simply absent from the answer, so a
   * caller resolving "why is this post missing?" gets a record or nothing.
   * Failures answer an empty map: the stub renders without a reason.
   */
  async getRemovals(kind: TargetKind, documentIds: readonly string[]): Promise<Map<string, DocumentRemoval>> {
    const removals = new Map<string, DocumentRemoval>();
    if (!this.canRemove(kind) || documentIds.length === 0) return removals;
    try {
      const sdk = await getEvoSdk();
      const page = await sdk.contracts.documentRemovals({
        contractId: YAPPR_CONTRACT_ID,
        documentTypeName: kind,
        documentIds: Array.from(new Set(documentIds)).slice(0, 100),
      });
      for (const entry of page.removals) removals.set(entry.documentId, toRemoval(entry));
    } catch (error) {
      logger.warn('moderationService: document removals read failed', error);
    }
    return removals;
  }

  /** One page of every removal record of a type, in document id order. */
  async listRemovals(kind: TargetKind, startAfter?: string): Promise<{ removals: DocumentRemoval[]; nextStartAfter?: string }> {
    if (!this.canRemove(kind)) return { removals: [] };
    const sdk = await getEvoSdk();
    const page = await sdk.contracts.documentRemovals({ contractId: YAPPR_CONTRACT_ID, documentTypeName: kind, startAfter, limit: 100 });
    return { removals: page.removals.map(toRemoval), nextStartAfter: page.nextStartAfter };
  }

  /** The contract's two fee pots. */
  async getFeePots(): Promise<{ owner: FeePotState; moderators: FeePotState } | null> {
    if (!contractIsModerated()) return null;
    const sdk = await getEvoSdk();
    const pots = await sdk.contracts.feePots(YAPPR_CONTRACT_ID);
    const toState = (pot: typeof pots.owner): FeePotState => ({
      credits: pot.credits,
      lastClaimEpoch: pot.lastClaimEpoch ?? null,
      lastClaimantId: pot.lastClaimantId ?? null,
    });
    return { owner: toState(pots.owner), moderators: toState(pots.moderators) };
  }

  // ---- Writes -------------------------------------------------------------

  async ban(moderatorId: string, identityId: string, reason: string): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.banUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId, reason: { text: reason } });
    }, identityId);
  }

  async unban(moderatorId: string, identityId: string): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.unbanUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId });
    }, identityId);
  }

  /** `until` is the block time, in ms, at which the suspension lapses; it must be in the future (41106). */
  async suspend(moderatorId: string, identityId: string, until: number, reason: string): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.suspendUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId, until: BigInt(until), reason: { text: reason } });
    }, identityId);
  }

  async unsuspend(moderatorId: string, identityId: string): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.unsuspendUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId });
    }, identityId);
  }

  /**
   * Deletes a post or reply as a moderator. The document is gone for good
   * (its owner gets no storage refund) and a removal record with `reason`
   * stays under the contract.
   */
  async removeDocument(moderatorId: string, kind: TargetKind, documentId: string, reason: string): Promise<ModerationResult> {
    if (!this.canRemove(kind)) {
      return { success: false, error: `Moderators cannot remove a ${kind} on this contract`, errorCode: 'NOT_MODERATED' };
    }
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.moderatorDeleteDocument({
        ...auth,
        contractId: YAPPR_CONTRACT_ID,
        documentTypeName: kind,
        documentId,
        reason: { text: reason },
      });
    });
  }

  /** Pays the moderators pot out to the whole team (any member may claim). */
  async claimModeratorsPot(moderatorId: string): Promise<ModerationResult & { remainingCredits?: bigint }> {
    let remainingCredits: bigint | undefined;
    const result = await this.moderate(moderatorId, async (sdk, auth) => {
      const claimed = await sdk.contracts.claimFees({ ...auth, contractId: YAPPR_CONTRACT_ID, pot: 'moderators' });
      remainingCredits = claimed.remainingCredits;
    });
    return remainingCredits === undefined ? result : { ...result, remainingCredits };
  }

  private async moderate(
    moderatorId: string,
    action: (sdk: EvoSDK, auth: ModeratorAuth) => Promise<void>,
    moderatedIdentityId?: string
  ): Promise<ModerationResult> {
    if (!contractIsModerated()) {
      return { success: false, error: 'This contract declares no moderation', errorCode: 'NOT_MODERATED' };
    }
    try {
      const sdk = await getEvoSdk();
      const { identity, signer } = await this.getCriticalSigner(moderatorId);
      await action(sdk, { identity, signer });
      if (moderatedIdentityId) this.standingCache.delete(moderatedIdentityId);
      return { success: true };
    } catch (error) {
      return this.toResult(error);
    }
  }

  /**
   * The moderating identity and an IdentitySigner holding its CRITICAL
   * authentication key: the only key a moderation transition may be signed
   * with. A HIGH login key answers NEEDS_CRITICAL_KEY without broadcasting.
   */
  private async getCriticalSigner(identityId: string) {
    const { getPrivateKey } = await import('../secure-storage');
    const wif = getPrivateKey(identityId)?.trim();
    if (!wif) {
      const { promptForAuthKey } = await import('../auth-utils');
      promptForAuthKey();
      throw new Error('Private key not found — please re-authenticate');
    }
    const sdk = await getEvoSdk();
    const identity = await sdk.identities.fetch(identityId);
    if (!identity) throw new Error('Identity not found');
    const match = matchIdentityKey(wif, identity.publicKeys, {
      network: keyNetwork(),
      purpose: KeyPurpose.AUTHENTICATION,
      allowedSecurityLevels: [SecurityLevel.CRITICAL],
    });
    if (!match.ok) throw new Error('critical key required');
    const signer = await signerService.createSigner(wif);
    return { identity, signer };
  }

  private toResult(error: unknown): ModerationResult {
    const msg = extractErrorMessage(error);
    logger.error('Moderation failed:', msg);
    const lower = msg.toLowerCase();
    const code = (n: number) => new RegExp(`\\bcode"?\\s*[=:]\\s*${n}\\b`).test(msg);
    if (lower.includes('critical key required') || (lower.includes('security level') && lower.includes('critical'))) {
      return { success: false, error: 'Moderation needs your CRITICAL key to authorize', errorCode: 'NEEDS_CRITICAL_KEY' };
    }
    if (code(41101) || code(41113) || lower.includes('not a moderator') || lower.includes('notcontractmoderator')) {
      return { success: false, error: 'This identity is not one of the contract\'s moderators', errorCode: 'NOT_MODERATOR' };
    }
    if (code(41100) || lower.includes('moderationnotenabled')) {
      return { success: false, error: 'The contract declares no moderation', errorCode: 'NOT_MODERATED' };
    }
    if (code(41111) || /already.{0,30}claimed.{0,30}epoch|alreadyclaimedthisepoch/.test(lower)) {
      return { success: false, error: 'The moderators pot was already paid out this epoch', errorCode: 'ALREADY_CLAIMED' };
    }
    if (code(41112) || /nothing.{0,10}to.{0,10}claim/.test(lower)) {
      return { success: false, error: 'The moderators pot is empty', errorCode: 'NOTHING_TO_CLAIM' };
    }
    if (lower.includes('private key not found')) {
      return { success: false, error: 'No signing key for this identity', errorCode: 'INVALID_KEY' };
    }
    return { success: false, error: msg, errorCode: 'NETWORK_ERROR' };
  }
}

export const moderationService = new ModerationService();

/**
 * True when a write was refused because the SIGNER is barred from the
 * contract: banned (ContractUserBannedError, 41107) or suspended
 * (ContractUserSuspendedError, 41108). The refusal is paid and bumps the
 * nonce, so retrying is pointless; the UI shows the standing instead.
 */
export function isBarredFromContractError(error: unknown): boolean {
  const msg = extractErrorMessage(error);
  return /\bcode"?\s*[=:]\s*4110[78]\b|contractuser(banned|suspended)|is (banned|suspended) (from|on) (this|the) contract/i.test(msg);
}
