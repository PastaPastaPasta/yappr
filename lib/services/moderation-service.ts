import { logger } from '@/lib/logger';
import { Document, PlatformVersion } from '@dashevo/evo-sdk';
import type { EvoSDK, Identity, IdentitySigner } from '@dashevo/evo-sdk';
import type { ContractModerationReason, ContractModerationStatus, ContractWarning } from '@dashevo/wasm-sdk';
import { YAPPR_CONTRACT_ID, keyNetwork } from '@/lib/constants';
import { contractIsModerated, contractKeepsWarnings, moderationListsKept, moderatorDeletableTypes, type TargetKind } from '@/lib/contract-topology';
import { matchIdentityKey } from '@/lib/crypto/keys';
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys';
import { classifyModerationError, extractErrorMessage, type ModerationErrorKind } from '@/lib/error-utils';
import { RESTORE_WINDOW_MS, dropSnapshot, loadSnapshot, removalHashOf, saveSnapshot } from '@/lib/moderation-snapshots';
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
 * Platform 4.2.0-beta.4 adds, all behind what the contract declares:
 *
 * - a **warning list** (`config.moderation.warnings`, platform#4872): a
 *   warning bars nothing, carries a reason and a block time, and at most 16
 *   accumulate until cleared (41118 past that);
 * - **reasons that cite documents** (platform#4884): `reason.documents`
 *   names at most 16 `{documentTypeName, documentId}` the action is about;
 *   `reason.reasonDocumentId` names a moderation-charters `reason` document,
 *   which a seated elected team must cite from its proposal (41203);
 * - **moderator restore** (platform#4885): a removal record now holds the
 *   removed document's hash, and within a week any moderator may bring the
 *   document back by handing over its exact bytes. Nothing on chain keeps
 *   those bytes, so `removeDocument` snapshots the document locally first
 *   (`lib/moderation-snapshots.ts`) and `restoreDocument` replays it.
 *
 * Wraps `sdk.contracts.{banUser, unbanUser, suspendUser, unsuspendUser,
 * warnUser, clearUserWarnings, moderatorDeleteDocument,
 * moderatorRestoreDocument, moderationStatus, moderationEntries,
 * documentRemovals, feePots, claimFees}`. Off a moderated topology every
 * write refuses locally and every read answers "nothing"; the warning list is
 * read and written only when the contract keeps one.
 *
 * Elected moderation (a `moderators: { $type: "elected" }` declaration, with
 * its team seated through the moderation-charters system contract,
 * `sdk.moderationCharters`) is declared by social v9 (interim
 * `contractOwner`, `ownerProtected`). `getTeam` follows Drive's
 * `may_moderate`: the interim moderates until a team is seated, then the team
 * alone. It is cached briefly and dropped after every moderation action, so a
 * team seated mid-session takes over within a minute. The election flow
 * itself lives elsewhere.
 */

export interface ModerationResult {
  success: boolean;
  /** `removeDocument` only: whether a copy was kept on this device, so the removal can be restored from here. */
  snapshotSaved?: boolean;
  error?: string;
  errorCode?: 'NOT_MODERATED' | 'NEEDS_CRITICAL_KEY' | 'INVALID_KEY' | 'ALREADY_CLAIMED' | 'NOTHING_TO_CLAIM' | 'NO_SNAPSHOT' | 'NETWORK_ERROR' | ModerationErrorKind;
}

/**
 * Why a moderator acted, as `ContractModerationReason` carries it: free text
 * (at most 1024 bytes), optionally the documents the action is about (at most
 * 16, none twice) and a moderation-charters `reason` document id.
 */
export interface ModerationReasonInput {
  text: string;
  documents?: ReadonlyArray<{ documentTypeName: string; documentId: string }>;
  reasonDocumentId?: string;
}

/** One warning an identity carries on the contract's warning list. */
export interface ModerationWarning {
  /** Block time (ms) the warning was issued. */
  warnedAt: number;
  reason: string;
  /** The documents the warning names (`reason.documents`); empty when none. */
  documents: Array<{ documentTypeName: string; documentId: string }>;
}

/** One identity's standing on the contract's lists, as the chain proves it. */
export interface ModerationStanding {
  banned: boolean;
  banReason: string | null;
  /** Block time (ms) the suspension lapses, or null when not suspended. */
  suspendedUntil: number | null;
  suspensionReason: string | null;
  /** The warnings the identity carries, oldest first; empty when none or when the contract keeps no warning list. */
  warnings: ModerationWarning[];
}

/** One banlist, suspension-list or warning-list entry. */
export interface ModerationEntry {
  identityId: string;
  /** The ban's or suspension's reason, or for a warning-list entry the latest warning's. */
  reason: string;
  /** Suspension list only: the block time (ms) the suspension lapses. */
  until?: number;
  /** Warning list only: every warning the identity carries, oldest first. */
  warnings?: ModerationWarning[];
}

/** The record a moderator's deletion left under the contract. */
export interface DocumentRemoval {
  documentId: string;
  documentOwnerId: string;
  moderatorId: string;
  reason: string;
  /** Block time (ms) of the removing block. */
  removedAt: number;
  /** Double SHA-256 (hex) of the document as removed: what a restore must match. */
  documentHash: string;
  /** Set once a moderator restored the document; it is live again. */
  restoredAt: number | null;
  restoredBy: string | null;
}

export interface FeePotState {
  credits: bigint;
  lastClaimEpoch: number | null;
  lastClaimantId: string | null;
}

/**
 * Who may moderate the contract: its owner, plus any appointed identities —
 * or, on an elected contract with a seated team, that team alone (the owner
 * and interim moderators can no longer act, 41101).
 */
export interface ModerationTeam {
  ownerId: string;
  /** Appointed moderators, or a seated elected team's leader and members; empty when only the owner moderates. */
  appointed: string[];
  /** True when the members are a seated elected team. */
  elected: boolean;
  /**
   * Whether the contract OWNER may moderate right now, as Drive decides it
   * (`ContractModerators::may_moderate`, `InterimModerators::may_moderate` in
   * rs-dpp `config/moderation/elected.rs`): always on an owner or appointed
   * declaration; on an elected one only under a `contractOwner` or
   * `appointedModerators` interim, and never once a team is seated or under a
   * `notYetUsable` / `noModeration` interim. `ownerProtected` protects the
   * owner from moderation; it does not let the owner moderate.
   */
  ownerModerates: boolean;
}

type ContractModeratorsDeclaration = NonNullable<NonNullable<Awaited<ReturnType<EvoSDK['contracts']['fetch']>>>['config']['moderation']>['moderators'];

/** The seated team's members, as `sdk.moderationCharters.team` reports them (null when none is seated). */
export interface SeatedTeamIds {
  leaderId: string;
  members: string[];
}

/**
 * Who moderates, from the contract's declaration and, for an elected one, the
 * seated team (if any). Pure: mirrors Drive's `may_moderate`.
 */
export function resolveModerationTeam(
  ownerId: string,
  moderators: ContractModeratorsDeclaration | undefined,
  seated: SeatedTeamIds | null
): ModerationTeam {
  const toIds = (ids: readonly unknown[]) => ids.map((id) => identifierToBase58(id) ?? String(id));
  if (moderators?.$type === 'elected') {
    // A seated team moderates alone: the owner and the interim no longer may (41101).
    if (seated) return { ownerId, appointed: [seated.leaderId, ...seated.members], elected: true, ownerModerates: false };
    const interim = moderators.interim;
    switch (interim.$type) {
      case 'contractOwner':
        return { ownerId, appointed: [], elected: false, ownerModerates: true };
      case 'appointedModerators':
        return { ownerId, appointed: toIds(interim.identities), elected: false, ownerModerates: true };
      default:
        // notYetUsable / noModeration: nobody moderates until a team is seated.
        return { ownerId, appointed: [], elected: false, ownerModerates: false };
    }
  }
  const appointed = moderators?.$type === 'appointedModerators' ? toIds(moderators.identities) : [];
  return { ownerId, appointed, elected: false, ownerModerates: true };
}

/** The moderating identity and a signer holding its CRITICAL key. */
interface ModeratorAuth {
  identity: Identity;
  signer: IdentitySigner;
}

const NO_STANDING: ModerationStanding = { banned: false, banReason: null, suspendedUntil: null, suspensionReason: null, warnings: [] };

const reasonText = (reason: ContractModerationReason | undefined): string | null =>
  reason === undefined ? null : reason.text;

/** At most 16 cited documents, none twice (10904 otherwise). */
const MAX_REASON_DOCUMENTS = 16;

/**
 * The SDK shape of a reason. `documents` and `reasonDocumentId` are only sent
 * when set: a pre-beta.4 reason is `{ text }` alone, and an empty list is
 * refused as malformed by nothing but is still noise in a public record.
 */
export function toModerationReason(input: ModerationReasonInput): ContractModerationReason {
  const seen = new Set<string>();
  const documents = (input.documents ?? []).filter((doc) => {
    const key = `${doc.documentTypeName}:${doc.documentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (documents.length > MAX_REASON_DOCUMENTS) {
    throw new Error(`A moderation reason may cite at most ${MAX_REASON_DOCUMENTS} documents`);
  }
  return {
    text: input.text,
    ...(documents.length > 0 ? { documents: documents.map((doc) => ({ ...doc })) } : {}),
    ...(input.reasonDocumentId ? { reasonDocumentId: input.reasonDocumentId } : {}),
  };
}

export const toWarning = (warning: ContractWarning): ModerationWarning => ({
  warnedAt: Number(warning.warnedAt),
  reason: warning.reason.text,
  documents: (warning.reason.documents ?? []).map((doc) => ({ documentTypeName: doc.documentTypeName, documentId: doc.documentId })),
});

/** A `documentRemovals` entry as the app models it — both removal reads decode it identically. */
type RemovalEntry = Awaited<ReturnType<EvoSDK['contracts']['documentRemovals']>>['removals'][number];

export const toRemoval = (entry: RemovalEntry): DocumentRemoval => ({
  documentId: entry.documentId,
  documentOwnerId: entry.documentOwnerId,
  moderatorId: entry.moderatorId,
  reason: entry.reason.text,
  removedAt: Number(entry.removedAt),
  documentHash: entry.documentHash,
  restoredAt: entry.restoredAt === undefined ? null : Number(entry.restoredAt),
  restoredBy: entry.restoredBy ?? null,
});

class ModerationService {
  /**
   * The in-flight or recent team fetch: a feed of cards asks once, not once
   * per card. Short-lived, because on an elected contract a team can be seated
   * mid-session, which moves moderation from the interim to the team.
   */
  private team: { promise: Promise<ModerationTeam>; at: number } | null = null;
  private static readonly TEAM_TTL_MS = 60_000;
  private standingCache = new Map<string, { standing: ModerationStanding; at: number }>();
  /** Standing rarely changes; a page of cards must not re-query it per card. */
  private static readonly STANDING_TTL_MS = 60_000;

  // ---- Who moderates ------------------------------------------------------

  /**
   * The contract's moderation team, from the contract and, when it declares
   * elected moderation, the seated charter. Cached for {@link TEAM_TTL_MS} and
   * dropped after every moderation action. Null when the topology declares no
   * moderation.
   */
  async getTeam(): Promise<ModerationTeam | null> {
    if (!contractIsModerated()) return null;
    if (!this.team || Date.now() - this.team.at >= ModerationService.TEAM_TTL_MS) {
      const promise = (async () => {
        const sdk = await getEvoSdk();
        const contract = await sdk.contracts.fetch(YAPPR_CONTRACT_ID);
        if (!contract) throw new Error('Social contract not found');
        const moderators = contract.config.moderation?.moderators;
        const seated = moderators?.$type === 'elected' ? await this.seatedTeam(sdk) : null;
        return resolveModerationTeam(contract.ownerId.toBase58(), moderators, seated);
      })();
      const entry = { promise, at: Date.now() };
      this.team = entry;
      // A failed fetch must not pin "not a moderator" until the TTL runs out.
      promise.catch(() => { if (this.team === entry) this.team = null; });
    }
    return this.team.promise;
  }

  /** Forget the cached team, so the next check reads it again (a team may have been seated). */
  invalidateTeam(): void {
    this.team = null;
  }

  /** The seated team's ids, copied out of the wasm object, which is freed before returning. */
  private async seatedTeam(sdk: EvoSDK): Promise<SeatedTeamIds | null> {
    const team = await sdk.moderationCharters.team(YAPPR_CONTRACT_ID);
    if (!team) return null;
    try {
      return { leaderId: team.leaderId.toBase58(), members: team.members.map((id) => id.toBase58()) };
    } finally {
      team.free();
    }
  }

  /** True when `identityId` is the contract owner or an appointed moderator. */
  async isModerator(identityId: string | null | undefined): Promise<boolean> {
    if (!identityId) return false;
    try {
      const team = await this.getTeam();
      if (team === null) return false;
      return team.appointed.includes(identityId) || (team.ownerModerates && team.ownerId === identityId);
    } catch (error) {
      logger.warn('moderationService: could not resolve the moderation team', error);
      return false;
    }
  }

  /** The document types a moderator may remove (`post`, `reply` on v8). */
  canRemove(kind: TargetKind): boolean {
    return moderatorDeletableTypes().includes(kind);
  }

  /** True when the contract keeps a warning list (a v8 re-cut with `warnings: true`). */
  canWarn(): boolean {
    return contractKeepsWarnings();
  }

  /**
   * True when this client can undo `removal`: the restore window is open, the
   * document is not live again, and a snapshot taken before the deletion is
   * still kept here and hashes to what the record holds (anything else is a
   * paid 41121).
   */
  canRestore(kind: TargetKind, removal: DocumentRemoval, now = Date.now()): boolean {
    if (!this.canRemove(kind) || removal.restoredAt !== null) return false;
    if (now > removal.removedAt + RESTORE_WINDOW_MS) return false;
    const bytes = loadSnapshot(kind, removal.documentId, now);
    return bytes !== null && removalHashOf(bytes) === removal.documentHash;
  }

  // ---- Reads --------------------------------------------------------------

  /**
   * An identity's standing on every list the contract keeps. Off a moderated
   * topology, or when the read fails, answers "in good standing" so a
   * transient fault never paints a user as banned; a WRITE failure carries its
   * own 41107/41108.
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
        lists: [...moderationListsKept()],
      });
      const standing: ModerationStanding = {
        banned: status.banned === true,
        banReason: reasonText(status.banReason),
        suspendedUntil: status.suspendedUntil === undefined ? null : Number(status.suspendedUntil),
        suspensionReason: reasonText(status.suspensionReason),
        warnings: (status.warnings ?? []).map(toWarning),
      };
      this.standingCache.set(identityId, { standing, at: Date.now() });
      return standing;
    } catch (error) {
      logger.warn('moderationService: moderation status read failed', error);
      return NO_STANDING;
    }
  }

  /** One page of a list the contract keeps, in identity id order; empty for a list it does not keep. */
  async listEntries(list: 'banlist' | 'suspensions' | 'warnings', startAfter?: string): Promise<{ entries: ModerationEntry[]; nextStartAfter?: string }> {
    if (!moderationListsKept().includes(list)) return { entries: [] };
    const sdk = await getEvoSdk();
    const page = await sdk.contracts.moderationEntries({ contractId: YAPPR_CONTRACT_ID, list, startAfter, limit: 100 });
    return {
      entries: page.entries.map((entry) => ({
        identityId: entry.identityId,
        reason: entry.reason.text,
        ...(entry.until === undefined ? {} : { until: Number(entry.until) }),
        ...(entry.warnings === undefined ? {} : { warnings: entry.warnings.map(toWarning) }),
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

  async ban(moderatorId: string, identityId: string, reason: string | ModerationReasonInput): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.banUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId, reason: reasonOf(reason) });
    }, identityId);
  }

  async unban(moderatorId: string, identityId: string): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.unbanUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId });
    }, identityId);
  }

  /** `until` is the block time, in ms, at which the suspension lapses; it must be in the future (41106). */
  async suspend(moderatorId: string, identityId: string, until: number, reason: string | ModerationReasonInput): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.suspendUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId, until: BigInt(until), reason: reasonOf(reason) });
    }, identityId);
  }

  async unsuspend(moderatorId: string, identityId: string): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.unsuspendUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId });
    }, identityId);
  }

  /**
   * Adds a warning to an identity on the contract's warning list. A warning
   * bars nothing; it is a public, reasoned note that accumulates (at most 16)
   * until a moderator clears it. Refused locally when the contract keeps no
   * warning list.
   */
  async warn(moderatorId: string, identityId: string, reason: string | ModerationReasonInput): Promise<ModerationResult> {
    if (!this.canWarn()) {
      return { success: false, error: 'This contract keeps no warning list', errorCode: 'NOT_MODERATED' };
    }
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.warnUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId, reason: reasonOf(reason) });
    }, identityId);
  }

  /** Clears every warning an identity carries (41117 when it carries none). */
  async clearWarnings(moderatorId: string, identityId: string): Promise<ModerationResult> {
    if (!this.canWarn()) {
      return { success: false, error: 'This contract keeps no warning list', errorCode: 'NOT_MODERATED' };
    }
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.clearUserWarnings({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId });
    }, identityId);
  }

  /**
   * Deletes a post or reply as a moderator. The document is gone for good
   * (its owner gets no storage refund) and a removal record with `reason`
   * stays under the contract.
   *
   * Before deleting, the document is fetched and its serialized bytes are
   * kept locally for the restore window, so this moderator (on this device)
   * can undo the removal with `restoreDocument`. A failed snapshot does not
   * block the removal; it only means there is nothing to restore from.
   */
  async removeDocument(moderatorId: string, kind: TargetKind, documentId: string, reason: string | ModerationReasonInput): Promise<ModerationResult> {
    if (!this.canRemove(kind)) {
      return { success: false, error: `Moderators cannot remove a ${kind} on this contract`, errorCode: 'NOT_MODERATED' };
    }
    let snapshotSaved = false;
    const result = await this.moderate(moderatorId, async (sdk, auth) => {
      snapshotSaved = await this.snapshotForRestore(sdk, kind, documentId);
      await sdk.contracts.moderatorDeleteDocument({
        ...auth,
        contractId: YAPPR_CONTRACT_ID,
        documentTypeName: kind,
        documentId,
        reason: reasonOf(reason),
      });
    });
    if (!result.success && snapshotSaved) dropSnapshot(kind, documentId);
    return { ...result, snapshotSaved: result.success && snapshotSaved };
  }

  /**
   * Brings back a post or reply a moderator removed, from the snapshot
   * `removeDocument` kept. Any moderator may restore whoever removed it, within
   * a week (41120); the bytes must hash to the record (41121); a unique value
   * someone took meanwhile refuses it (40105). The restoring moderator pays the
   * storage.
   */
  async restoreDocument(moderatorId: string, kind: TargetKind, documentId: string): Promise<ModerationResult> {
    if (!this.canRemove(kind)) {
      return { success: false, error: `Moderators cannot restore a ${kind} on this contract`, errorCode: 'NOT_MODERATED' };
    }
    const bytes = loadSnapshot(kind, documentId);
    if (!bytes) {
      return { success: false, error: 'This device kept no copy of the removed document, so it cannot be restored from here', errorCode: 'NO_SNAPSHOT' };
    }
    const result = await this.moderate(moderatorId, async (sdk, auth) => {
      const contract = await sdk.contracts.fetch(YAPPR_CONTRACT_ID);
      if (!contract) throw new Error('Social contract not found');
      // A fresh Document for the call, never a caller's: nothing holds a wasm
      // borrow on it across the await.
      const document = Document.fromBytes(bytes, contract, kind, PlatformVersion.latest());
      await sdk.contracts.moderatorRestoreDocument({ ...auth, contractId: YAPPR_CONTRACT_ID, documentTypeName: kind, document });
    });
    if (result.success || result.errorCode === 'ALREADY_RESTORED' || result.errorCode === 'RESTORE_WINDOW_ELAPSED' || result.errorCode === 'RESTORE_HASH_MISMATCH') {
      dropSnapshot(kind, documentId);
    }
    return result;
  }

  /**
   * Keep the document's serialized bytes before a moderator deletes it. The
   * removal record hashes the document serialized under its type from the
   * state Drive reads, so the serialization here must be of the document as
   * fetched now, under the contract as it is now.
   */
  private async snapshotForRestore(sdk: EvoSDK, kind: TargetKind, documentId: string): Promise<boolean> {
    try {
      const [contract, document] = await Promise.all([
        sdk.contracts.fetch(YAPPR_CONTRACT_ID),
        sdk.documents.get(YAPPR_CONTRACT_ID, kind, documentId),
      ]);
      if (!contract || !document) return false;
      return saveSnapshot(kind, documentId, document.toBytes(contract, PlatformVersion.latest()));
    } catch (error) {
      logger.warn('moderationService: could not snapshot the document before removal; it will not be restorable', error);
      return false;
    }
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
    } finally {
      // Succeeded or refused, the team may have moved (a 41101 usually means a
      // team was seated since it was read): the next check reads it again.
      this.invalidateTeam();
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
    const kind = classifyModerationError(error) ?? (lower.includes('not a moderator') ? 'NOT_MODERATOR' : null);
    if (kind) {
      return { success: false, error: MODERATION_ERROR_MESSAGES[kind], errorCode: kind };
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

const reasonOf = (reason: string | ModerationReasonInput): ContractModerationReason =>
  toModerationReason(typeof reason === 'string' ? { text: reason } : reason);

const MODERATION_ERROR_MESSAGES: Record<ModerationErrorKind, string> = {
  NOT_MODERATOR: 'This identity is not one of the contract\'s moderators',
  NOT_WARNED: 'That identity carries no warnings to clear',
  WARNING_LIMIT: 'That identity already carries the most warnings it can; clear them before warning again',
  NO_REMOVAL_RECORD: 'There is no moderator removal of that document to undo',
  RESTORE_WINDOW_ELAPSED: 'The week in which a removal can be undone has passed',
  RESTORE_HASH_MISMATCH: 'The copy kept on this device is not the document that was removed',
  ALREADY_RESTORED: 'That document was already restored',
  UNIQUE_VALUE_TAKEN: 'Another document took a unique value this one needs, so it cannot come back',
  NOT_YET_SEATED: 'No moderation team is seated on this contract yet',
  ABILITY_NOT_GRANTED: 'The elected team is not granted that moderation ability',
  ADDED_MODERATOR_LIMIT: 'The team already has as many added moderators as the contract allows',
  REASON_NOT_LISTED: 'The seated team must cite a reason its charter lists',
  INVALID_REASON_DOCUMENTS: 'A reason may cite at most 16 documents, each once',
  CHARTER_INVALID: 'The moderation charter is malformed',
  CONTEST_NOT_JOINABLE: 'That election is not open to join',
};

export const moderationService = new ModerationService();

