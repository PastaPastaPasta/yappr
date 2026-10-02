import { logger } from '@/lib/logger';
import { Document, PlatformVersion } from '@dashevo/evo-sdk';
import type { EvoSDK, Identity, IdentitySigner } from '@dashevo/evo-sdk';
import type { ContractModerationReason, ContractModerationStatus, ContractTeamActionEntry, ContractTeamActionStatus, ContractWarning } from '@dashevo/wasm-sdk';
import { YAPPR_CONTRACT_ID, keyNetwork } from '@/lib/constants';
import { authorDeletesLeaveHoles, contractIsModerated, contractKeepsWarnings, electedModeration, isV11, moderationListsKept, moderatorDeletableTypes, moderatorDeleteWindowSeconds, moderatorDeletionKeepsRecord, reportsAreResolved, settledDeletionFor, type SettledDeletionRule, type TargetKind } from '@/lib/contract-topology';
import { matchIdentityKey } from '@/lib/crypto/keys';
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys';
import { classifyModerationError, extractErrorMessage, hasConsensusCode, isDocumentExpiredError, isTimeoutError, isUnverifiedOutcomeError, type ModerationErrorKind } from '@/lib/error-utils';
import { isReportGoneError, type ReportRecord, type ReportStatus } from '@/lib/reports';
import { RESTORE_WINDOW_MS, dropSnapshot, loadSnapshot, removalHashOf, saveSnapshot } from '@/lib/moderation-snapshots';
import { getEvoSdk } from './evo-sdk-service';
import { withSdkSignedWrite } from './identity-nonce';
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
 * Platform 4.2.0-beta.7 (social v10) replaces `canBeDeletedByModerators`
 * with `moderatorAbilities`: `report` declares `changeFields: [status,
 * resolution]`, so the moderators resolve a report in place
 * (`moderatorChangeDocumentFields`) instead of deleting it, and a deleted
 * report keeps no removal record (`deleteKeepsRecord: false`), so
 * `documentRemovals` is never asked about one.
 *
 * Wraps `sdk.contracts.{banUser, unbanUser, suspendUser, unsuspendUser,
 * warnUser, clearUserWarnings, moderatorDeleteDocument,
 * moderatorRestoreDocument, moderatorChangeDocumentFields, moderationStatus,
 * moderationEntries, documentRemovals, feePots, claimFees,
 * moderatorDeleteSettledDocument, moderatorApproveTeamAction, teamActions,
 * teamActionSigners, moderationActionCounts}`. Off a moderated topology every
 * write refuses locally and every read answers "nothing"; the warning list is
 * read and written only when the contract keeps one.
 *
 * Platform 5.0.0-beta.1 (social v11) adds, again behind what the contract
 * declares (`removalKeptFieldsFor`, `settledDeletionFor`):
 *
 * - **removal records that keep fields** (`deleteKeepsFields`): a removed
 *   post's record keeps its `hashtag` and `$createdAt`, a reply's its
 *   `rootPostId` and `$createdAt` (`DocumentRemoval.kept`), so a hole can say
 *   what it was;
 * - **settled documents** (`deleteWithin` + `deleteSettled`): one moderator
 *   deletes a post or reply alone for a week after it was written (41116
 *   past that); after that only the seated team does, together: a member
 *   proposes (`moderatorDeleteSettledDocument`, its own approval) and the
 *   others approve (`moderatorApproveTeamAction`) until the leader and enough
 *   members agree. Such a deletion is never restored (41209);
 * - **moderation reads**: the team's actions and who signed each
 *   (`teamActions`, `teamActionSigners`) and how many counted actions each
 *   member signed since the pot was last paid out (`moderationActionCounts`).
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
  /**
   * `MAYBE_APPLIED`: the broadcast went out but its confirmation timed out (the
   * DAPI gateway 504s even when a transition lands), so the action may well
   * have happened — the caller says "check again", never "failed".
   */
  errorCode?: 'NEEDS_CRITICAL_KEY' | 'INVALID_KEY' | 'ALREADY_CLAIMED' | 'NOTHING_TO_CLAIM' | 'NO_SNAPSHOT' | 'MAYBE_APPLIED' | 'NETWORK_ERROR' | 'DOCUMENT_GONE' | ModerationErrorKind;
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
  /** What the record keeps of the document (v11 `deleteKeepsFields`); empty before v11. */
  kept: RemovalKeptFields;
}

/**
 * The fields a removal record kept of the removed document, each only when
 * the record holds it: a post's `hashtag`, a reply's `rootPostId`, and either's
 * `$createdAt` (ms).
 */
export interface RemovalKeptFields {
  hashtag?: string;
  rootPostId?: string;
  createdAt?: number;
}

/**
 * Where a document stands against its type's moderator deletion window
 * (`deleteWithin`, measured by Drive from `$updatedAt` on a mutable type and
 * from `$createdAt` on an immutable one). v11's post and reply are mutable, so
 * the window runs from `$updatedAt`, and an author's tombstone reopens it.
 * The client measures from `$createdAt` (the `Post` model carries no
 * `$updatedAt`). That is exact for every live post and reply, since the
 * tombstone is the only edit consensus allows, and a tombstone shows no
 * moderator menu on v11 (`tombstonesAreHidden()`); were one offered, a
 * settled-looking tombstone would really be open, and the node decides.
 *
 * - `open`: one moderator deletes it alone;
 * - `closing`: within {@link SETTLE_MARGIN_MS} of the window's end either
 *   way, where block time and this device's clock may disagree: a single
 *   deletion is still offered and the node decides (41116 once settled);
 * - `settled`: past the window; only the seated team deletes it together.
 *
 * A type with no window (v2, v9, v10) is always `open`.
 */
export type DeletionPhase = 'open' | 'closing' | 'settled';

/** How far block time may sit from this device's clock around a deletion window's end. */
export const SETTLE_MARGIN_MS = 60_000;

export function deletionPhase(windowSeconds: number | null, createdAtMs: number, now = Date.now()): DeletionPhase {
  if (windowSeconds === null || !Number.isFinite(createdAtMs)) return 'open';
  const end = createdAtMs + windowSeconds * 1000;
  if (now < end - SETTLE_MARGIN_MS) return 'open';
  return now <= end + SETTLE_MARGIN_MS ? 'closing' : 'settled';
}

/**
 * Approvals a settled deletion needs: the rule's, capped at the seats the team
 * can hold (`team.seats(maxAddedModerators)`), as consensus counts them. With
 * no seat count read, the rule's own figure.
 */
export function neededApprovals(rule: Pick<SettledDeletionRule, 'approvals'>, seats: number | null): number {
  return seats === null ? rule.approvals : Math.max(1, Math.min(rule.approvals, seats));
}

/** How the viewer may take down one post or reply now. */
export type RemovalRoute =
  /** One moderator's delete; `closing` when the window may close before it lands. */
  | { route: 'single'; closing: boolean }
  /**
   * Settled: the viewer, on the seated team, proposes; `needed` approvals
   * delete it, the leader's among them when `leaderRequired`. `reachable` is
   * false while the team has fewer people than `needed` (seats count added
   * places the leader has not filled), so a proposal could never run.
   */
  | { route: 'team'; needed: number; leaderRequired: boolean; leaderId: string; viewerIsLeader: boolean; reachable: boolean }
  /**
   * Settled, and the viewer cannot take it down: no team is seated (41205),
   * the viewer is not on the seated team, or the type sets no settled rule.
   */
  | { route: 'none'; why: 'noTeamSeated' | 'notOnTeam' | 'noSettledRule' };

/** The seated team as the settled-deletion flow needs it, copied out of the wasm `ModerationTeam`. */
export interface SeatedTeamSeats {
  leaderId: string;
  /** The members besides the leader, as the team is now. */
  members: string[];
  /** The members the charter's election seated, removed since or not: each holds a seat. Empty where nothing is deleted by the team (before v11). */
  electedMembers: string[];
  /** The most members the team can hold (`seats(maxAddedModerators)`), leader included; null before v11 or when it could not be counted. */
  seats: number | null;
}

/**
 * True when the team as it sits now has the people to give `needed`
 * approvals: the leader and its members. A seat count includes added places
 * the leader has not filled, and a proposal never lapses, so one made while
 * this is false waits until the leader adds members.
 */
export function teamCanApprove(needed: number, seated: Pick<SeatedTeamSeats, 'members'>): boolean {
  return needed <= 1 + seated.members.length
}

/** Pure: which {@link RemovalRoute} applies to a document in `phase`. */
export function removalRouteFor(
  phase: DeletionPhase,
  rule: SettledDeletionRule | null,
  seated: SeatedTeamSeats | null,
  viewerId: string
): RemovalRoute {
  if (phase !== 'settled') return { route: 'single', closing: phase === 'closing' };
  if (!rule) return { route: 'none', why: 'noSettledRule' };
  if (!seated) return { route: 'none', why: 'noTeamSeated' };
  if (seated.leaderId !== viewerId && !seated.members.includes(viewerId)) return { route: 'none', why: 'notOnTeam' };
  const needed = neededApprovals(rule, seated.seats);
  return {
    route: 'team',
    needed,
    leaderRequired: rule.leaderRequired,
    leaderId: seated.leaderId,
    viewerIsLeader: seated.leaderId === viewerId,
    // With no seat count read, the cap is unknown: let the node decide.
    reachable: seated.seats === null || teamCanApprove(needed, seated),
  };
}

/** One action the seated team votes on: today, the deletion of a settled post or reply. */
export interface TeamAction {
  actionId: string;
  status: ContractTeamActionStatus;
  proposerId: string;
  /** Block time (ms) of the proposal. */
  proposedAt: number;
  documentTypeName: string;
  documentId: string;
  /** The document's last modification (ms) when proposed: the approvals are of the document as it was then. */
  documentLastModifiedAt: number;
  reason: string;
  reasonDocumentId: string | null;
  /**
   * Approvals it holds, the proposer's among them. For an active action an
   * upper bound: a member who left is counted until a later approval reads the
   * team. {@link countedSigners} gives the exact figure from the signers.
   */
  approvalCount: number;
  /** Approvals the type's rule needs (`min(approvals, seats)`), or null when the type sets no settled rule. */
  neededApprovals: number | null;
  /** Whether the leader must be among them. */
  leaderRequired: boolean;
}

export const toTeamAction = (entry: ContractTeamActionEntry, status: ContractTeamActionStatus, seats: number | null): TeamAction => {
  const rule = settledDeletionFor(entry.event.documentTypeName);
  return {
    actionId: entry.actionId,
    status,
    proposerId: entry.proposerId,
    proposedAt: Number(entry.proposedAt),
    documentTypeName: entry.event.documentTypeName,
    documentId: entry.event.documentId,
    documentLastModifiedAt: Number(entry.event.documentLastModifiedAt),
    reason: entry.event.reason.text,
    reasonDocumentId: entry.event.reason.reasonDocumentId ?? null,
    approvalCount: entry.approvalCount,
    neededApprovals: rule ? neededApprovals(rule, seats) : null,
    leaderRequired: rule?.leaderRequired === true,
  };
};

/** Whether an active team action can still run against its document as it stands now. */
export type TeamActionTargetState = 'live' | 'changed' | 'gone';

/** The two document times Drive reads for an action's 41211 check, as the SDK's Document carries them. */
export interface TeamActionTargetTimes {
  updatedAt?: bigint | number | null;
  createdAt?: bigint | number | null;
}

/**
 * Where an active action's document stands. Drive refuses an approval once the
 * document is gone (40101) or was modified after the proposal (41211: its
 * `$updatedAt`, or `$createdAt` without one, differs from the action's
 * `documentLastModifiedAt`). On v11 its author's tombstone is such a change, and
 * so is a replace that changes nothing. Neither kind of action ever lapses, so
 * the queue has to say itself that it can never run. `doc` null = proved absent.
 */
export function teamActionTargetState(action: Pick<TeamAction, 'documentLastModifiedAt'>, doc: TeamActionTargetTimes | null): TeamActionTargetState {
  if (!doc) return 'gone';
  // Drive's `updated_at().or(created_at()).unwrap_or(0)`. It also compares
  // `$revision`, which only a moderator's field change moves without
  // `$updatedAt`; no type the team deletes (post, reply) declares changeFields.
  const modified = Number(doc.updatedAt ?? doc.createdAt ?? 0);
  return modified !== action.documentLastModifiedAt ? 'changed' : 'live';
}

/** The signers whose approvals count: those still on the team (an active action's `approvalCount` may include some who left). */
export function countedSigners(signerIds: readonly string[], seated: Pick<SeatedTeamSeats, 'leaderId' | 'members'> | null): string[] {
  if (!seated) return [...signerIds];
  return signerIds.filter((id) => id === seated.leaderId || seated.members.includes(id));
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

/**
 * The identities no moderation may act on, mirroring Drive's
 * `ContractModerators::protects`: everyone who may moderate right now, and the
 * owner when an elected declaration says `ownerProtected`. A moderator's
 * delete of a document one of them owns (a report they filed, say) is a paid
 * 41102.
 */
export function protectedIdentities(team: ModerationTeam, ownerProtected: boolean): Set<string> {
  return new Set([...team.appointed, ...(team.ownerModerates || ownerProtected ? [team.ownerId] : [])]);
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
/** A reason's text is at most 1024 BYTES of UTF-8 (10903 otherwise); a text box's `maxLength` counts characters. */
const MAX_REASON_TEXT_BYTES = 1024;

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
  const textBytes = new TextEncoder().encode(input.text).length;
  if (textBytes > MAX_REASON_TEXT_BYTES) {
    // Drive's own wording (10903), so the refusal classifies the same either way.
    throw new Error(`The text of a contract moderation reason is ${textBytes} bytes long, the maximum is ${MAX_REASON_TEXT_BYTES}`);
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
  kept: toKeptFields(entry.keptFields),
});

/**
 * "Sep 30" for a kept `$createdAt` this year, "Sep 30, 2025" for an older one:
 * how a removed post's hole says when it was written.
 */
export function postedOnLabel(createdAtMs: number, now = Date.now()): string {
  const date = new Date(createdAtMs);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** A kept timestamp, as the document's properties show it (a number, a bigint, or a numeric string), in ms. */
function keptTime(value: unknown): number | undefined {
  const ms = typeof value === 'bigint' || typeof value === 'string' ? Number(value) : value instanceof Date ? value.getTime() : value;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * The kept fields the app reads, typed. Anything else the record keeps, or a
 * value of an unexpected shape, is left out: the hole simply says less.
 */
export function toKeptFields(keptFields: Readonly<Record<string, unknown>> | undefined): RemovalKeptFields {
  if (!keptFields) return {};
  const kept: RemovalKeptFields = {};
  const { hashtag, rootPostId, $createdAt: createdAt } = keptFields;
  if (typeof hashtag === 'string' && hashtag) kept.hashtag = hashtag;
  const root = rootPostId === undefined || rootPostId === null ? null : identifierToBase58(rootPostId);
  if (root) kept.rootPostId = root;
  const at = keptTime(createdAt);
  if (at !== undefined) kept.createdAt = at;
  return kept;
}

/**
 * What the hole a missing post or reply leaves may claim. A takedown needs a
 * standing removal record. A RESTORED record means the document came back,
 * so the old reason no longer applies: its absence here is a failed read,
 * unless authors delete for real (v10) and absence is proved, which is the
 * author's delete after the restore (a moderator deleting it again would have
 * left a fresh, standing record). Proof of absence with no record is a takedown
 * where only moderators can remove posts (v9, and v11, where an author's
 * delete is a tombstone that stays), and the author's own delete
 * where authors can too (`authorsDelete`, v10: every moderator deletion of a
 * post or reply leaves a record). That reading needs the record lookup to
 * have ANSWERED with nothing (`recordsRead`): while it is pending, or when it
 * failed, a takedown is indistinguishable from the author's delete, so the
 * hole claims neither. With neither record nor proof, the stub says
 * "unavailable".
 */
export function missingDocumentState(
  removal: DocumentRemoval | null,
  proven: boolean,
  { recordsRead = false, authorsDelete = authorDeletesLeaveHoles() }: { recordsRead?: boolean; authorsDelete?: boolean } = {}
): 'removed' | 'deleted' | 'loadFailed' | 'unavailable' {
  if (removal?.restoredAt === null) return 'removed';
  if (removal) return proven && authorsDelete && recordsRead ? 'deleted' : 'loadFailed';
  if (!proven) return 'unavailable';
  if (!authorsDelete) return 'removed';
  return recordsRead ? 'deleted' : 'unavailable';
}

class ModerationService {
  /**
   * The in-flight or recent team fetch: a feed of cards asks once, not once
   * per card. Short-lived, because on an elected contract a team can be seated
   * mid-session, which moves moderation from the interim to the team.
   */
  private team: { promise: Promise<{ team: ModerationTeam; seated: SeatedTeamSeats | null }>; at: number } | null = null;
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
    const read = this.readTeam();
    return read === null ? null : (await read).team;
  }

  /**
   * The seated team with its seat count, from the same cached read as
   * {@link getTeam}: null off a moderated topology or while no team is seated.
   * Throws when the read fails.
   */
  async getSeatedTeam(): Promise<SeatedTeamSeats | null> {
    const read = this.readTeam();
    return read === null ? null : (await read).seated;
  }

  private readTeam(): Promise<{ team: ModerationTeam; seated: SeatedTeamSeats | null }> | null {
    if (!contractIsModerated()) return null;
    if (!this.team || Date.now() - this.team.at >= ModerationService.TEAM_TTL_MS) {
      const promise = (async () => {
        const sdk = await getEvoSdk();
        const contract = await sdk.contracts.fetch(YAPPR_CONTRACT_ID);
        if (!contract) throw new Error('Social contract not found');
        const moderators = contract.config.moderation?.moderators;
        const seated = moderators?.$type === 'elected' ? await this.seatedTeam(sdk, moderators.maxAddedModerators ?? 0) : null;
        return { team: resolveModerationTeam(contract.ownerId.toBase58(), moderators, seated), seated };
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

  /**
   * The seated team's ids, copied out of the wasm object, which is freed
   * before returning. Where the team deletes settled documents (v11) also its
   * seat count, which caps a settled deletion's approvals, and its elected
   * members; read in their own try, so a failure there can never break the
   * moderator checks every topology runs.
   */
  private async seatedTeam(sdk: EvoSDK, maxAddedModerators: number): Promise<SeatedTeamSeats | null> {
    const team = await sdk.moderationCharters.team(YAPPR_CONTRACT_ID);
    if (!team) return null;
    try {
      let seats: number | null = null;
      let electedMembers: string[] = [];
      if (this.teamDeletesSettled()) {
        try {
          seats = team.seats(maxAddedModerators);
          electedMembers = team.electedMembers.map((id) => id.toBase58());
        } catch (error) {
          logger.warn('moderationService: could not count the seated team\'s seats', error);
        }
      }
      return { leaderId: team.leaderId.toBase58(), members: team.members.map((id) => id.toBase58()), electedMembers, seats };
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

  /** The document types a moderator may remove (`post`, `reply` on v9). */
  canRemove(kind: TargetKind): boolean {
    return moderatorDeletableTypes().includes(kind);
  }

  /** True when the contract keeps a warning list (`warnings: true`, as v9 declares). */
  canWarn(): boolean {
    return contractKeepsWarnings();
  }

  /**
   * True when a moderator's deletion of `kind` leaves a removal record that
   * `documentRemovals` can answer for. Asking it about a type that keeps none
   * (v10's `report`) is refused, so the reads below never do.
   */
  private keepsRemovals(kind: TargetKind): boolean {
    return this.canRemove(kind) && moderatorDeletionKeepsRecord(kind);
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

  // ---- Settled documents (v11) ------------------------------------------

  /** True when some type's settled documents are deleted by the seated team together (v11 post and reply). */
  teamDeletesSettled(): boolean {
    return moderatorDeletableTypes().some((type) => settledDeletionFor(type) !== null);
  }

  /** Where a `kind` written at `createdAt` stands against its deletion window ({@link DeletionPhase}); always `open` before v11. */
  deletionPhaseOf(kind: TargetKind, createdAt: Date | number, now = Date.now()): DeletionPhase {
    return deletionPhase(moderatorDeleteWindowSeconds(kind), createdAt instanceof Date ? createdAt.getTime() : createdAt, now);
  }

  /**
   * True when a `kind` written at `createdAt` is clearly past its window, so
   * no single moderator may delete it (41116). Within a minute of the window's
   * end it is not yet treated as settled: the single delete is offered and the
   * node decides.
   */
  isSettled(kind: TargetKind, createdAt: Date | number, now = Date.now()): boolean {
    return this.deletionPhaseOf(kind, createdAt, now) === 'settled';
  }

  /**
   * How `viewerId` may take down a `kind` written at `createdAt`: alone while
   * its window is open, by proposing to the seated team once it settled, or
   * not at all. Reads the (cached) seated team only for a settled document.
   */
  async removalRoute(viewerId: string, kind: TargetKind, createdAt: Date | number, now = Date.now()): Promise<RemovalRoute> {
    const phase = this.deletionPhaseOf(kind, createdAt, now);
    if (phase !== 'settled') return removalRouteFor(phase, null, null, viewerId);
    const rule = settledDeletionFor(kind);
    return removalRouteFor(phase, rule, rule ? await this.getSeatedTeam() : null, viewerId);
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
      return await this.readStanding(identityId);
    } catch (error) {
      logger.warn('moderationService: moderation status read failed', error);
      return NO_STANDING;
    }
  }

  /**
   * An identity's standing, read fresh and proved, THROWING when the read
   * fails. For a moderator's status check, where "in good standing" must mean
   * the chain said so, not that the read broke. Feed cards use the lenient
   * {@link getStanding}.
   */
  async readStanding(identityId: string): Promise<ModerationStanding> {
    if (!contractIsModerated()) return NO_STANDING;
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
   * Failures answer an empty map: the report queue renders without a reason.
   * Where "no record" is itself a claim (the author's delete), use the strict
   * {@link readRemovals}.
   */
  async getRemovals(kind: TargetKind, documentIds: readonly string[]): Promise<Map<string, DocumentRemoval>> {
    try {
      return await this.readRemovals(kind, documentIds);
    } catch (error) {
      logger.warn('moderationService: document removals read failed', error);
      return new Map();
    }
  }

  /**
   * The removal records of specific documents, THROWING when the read fails,
   * so an empty answer means the chain has no record. A type moderators
   * cannot delete, or whose moderator deletions keep no record, has none to
   * find.
   */
  async readRemovals(kind: TargetKind, documentIds: readonly string[]): Promise<Map<string, DocumentRemoval>> {
    const removals = new Map<string, DocumentRemoval>();
    if (!this.keepsRemovals(kind) || documentIds.length === 0) return removals;
    const sdk = await getEvoSdk();
    const page = await sdk.contracts.documentRemovals({
      contractId: YAPPR_CONTRACT_ID,
      documentTypeName: kind,
      documentIds: Array.from(new Set(documentIds)).slice(0, 100),
    });
    for (const entry of page.removals) removals.set(entry.documentId, toRemoval(entry));
    return removals;
  }

  /** One page of every removal record of a type, in document id order. */
  async listRemovals(kind: TargetKind, startAfter?: string): Promise<{ removals: DocumentRemoval[]; nextStartAfter?: string }> {
    if (!this.keepsRemovals(kind)) return { removals: [] };
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

  /**
   * The seated team's actions of `status`, each with the approvals its rule
   * needs (`min(approvals, seats)` of the team as it now sits). Action ids are
   * hashes, so their order says nothing about time: every page is read, up to
   * `max` actions, and `truncated` says when more were left unread. Empty
   * where no type is deleted by the team (before v11). Throws when a read fails.
   */
  async listTeamActions(status: ContractTeamActionStatus, { max = TEAM_ACTIONS_MAX } = {}): Promise<{ actions: TeamAction[]; truncated: boolean }> {
    if (!this.teamDeletesSettled()) return { actions: [], truncated: false };
    const sdk = await getEvoSdk();
    const seated = await this.getSeatedTeam();
    const actions: TeamAction[] = [];
    let startAtActionId: string | undefined;
    for (;;) {
      const page = await sdk.contracts.teamActions({
        contractId: YAPPR_CONTRACT_ID,
        status,
        ...(startAtActionId ? { startAtActionId, startAtActionIdIncluded: false } : {}),
        limit: TEAM_ACTIONS_PAGE,
      });
      for (const entry of page.actions) actions.push(toTeamAction(entry, status, seated?.seats ?? null));
      startAtActionId = page.nextStartAtActionId;
      if (!startAtActionId) return { actions, truncated: false };
      if (actions.length >= max) return { actions, truncated: true };
    }
  }

  /**
   * The active team action proposing the removal of `documentId` that can still
   * run, if any: a second proposal would split the team's approvals. Drive takes
   * any number of proposals per document and none lapses, so one made before the
   * document changed (41211 on every approval) or before another removed it is
   * skipped; when the document cannot be read, the first proposal found is
   * returned, as before.
   */
  async findActiveTeamAction(documentId: string): Promise<TeamAction | null> {
    const { actions } = await this.listTeamActions('active');
    const proposals = actions.filter((action) => action.documentId === documentId);
    if (proposals.length === 0) return null;
    const states = await this.readTeamActionTargets(proposals);
    if (states.size === 0) return proposals[0];
    return proposals.find((action) => states.get(action.actionId) === 'live') ?? null;
  }

  /**
   * {@link teamActionTargetState} for each of `actions`, from one proved `$id in`
   * read per document type. An action of a type that failed to read is left out:
   * nothing is claimed for it.
   */
  async readTeamActionTargets(actions: readonly TeamAction[]): Promise<Map<string, TeamActionTargetState>> {
    const states = new Map<string, TeamActionTargetState>();
    const byKind = new Map<string, TeamAction[]>();
    for (const action of actions) byKind.set(action.documentTypeName, [...(byKind.get(action.documentTypeName) ?? []), action]);
    await Promise.all([...byKind].map(async ([kind, group]) => {
      try {
        const sdk = await getEvoSdk();
        const found = new Map<string, TeamActionTargetTimes>();
        const ids = Array.from(new Set(group.map((action) => action.documentId)));
        for (let start = 0; start < ids.length; start += TEAM_TARGETS_PER_READ) {
          const batch = ids.slice(start, start + TEAM_TARGETS_PER_READ);
          const page = await sdk.documents.query({ dataContractId: YAPPR_CONTRACT_ID, documentTypeName: kind, where: [['$id', 'in', batch]], limit: batch.length });
          for (const [id, doc] of page) if (doc) found.set(String(id), { updatedAt: doc.updatedAt, createdAt: doc.createdAt });
        }
        for (const action of group) states.set(action.actionId, teamActionTargetState(action, found.get(action.documentId) ?? null));
      } catch (error) {
        logger.warn(`moderationService: could not read the ${kind} documents of the team's actions`, error);
      }
    }));
    return states;
  }

  /**
   * Who approved a team action of `status`, the proposer among them, in
   * identity id order; empty when no such action has that status. Throws when
   * the read fails.
   */
  async teamActionSigners(actionId: string, status: ContractTeamActionStatus): Promise<string[]> {
    if (!this.teamDeletesSettled()) return [];
    const sdk = await getEvoSdk();
    const { signerIds } = await sdk.contracts.teamActionSigners({ contractId: YAPPR_CONTRACT_ID, status, actionId });
    return [...signerIds];
  }

  /**
   * How many counted moderation actions (bans, suspensions, warnings,
   * deletions) each seated member signed since the moderators pot was last
   * paid out: what the action share of a claim splits by. Null where the
   * contract keeps no counts (not elected, or before v11) and when the node
   * refuses or the read fails: the pot panel simply shows no counts.
   */
  async getActionCounts(): Promise<Map<string, number> | null> {
    if (!isV11() || electedModeration() === null) return null;
    try {
      const sdk = await getEvoSdk();
      const { counts } = await sdk.contracts.moderationActionCounts(YAPPR_CONTRACT_ID);
      return new Map(counts.map(({ identityId, count }) => [identityId, count]));
    } catch (error) {
      logger.warn('moderationService: moderation action counts read failed', error);
      return null;
    }
  }

  // ---- Writes -------------------------------------------------------------

  async ban(moderatorId: string, identityId: string, reason: string | ModerationReasonInput): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.banUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId, reason: reasonOf(reason) });
    }, identityId, reason);
  }

  async unban(moderatorId: string, identityId: string): Promise<ModerationResult> {
    return this.moderate(moderatorId, async (sdk, auth) => {
      await sdk.contracts.unbanUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId });
    }, identityId);
  }

  /** `until` is the block time, in ms, at which the suspension lapses; it must be in the future (41106). */
  async suspend(moderatorId: string, identityId: string, until: number, reason: string | ModerationReasonInput): Promise<ModerationResult> {
    let targetBanned = false;
    const result = await this.moderate(moderatorId, async (sdk, auth) => {
      try {
        await sdk.contracts.suspendUser({ ...auth, contractId: YAPPR_CONTRACT_ID, identityId, until: BigInt(until), reason: reasonOf(reason) });
      } catch (error) {
        // Drive answers a suspension of a BANNED identity with 41107, whose
        // prose ("... is banned ... and can not act on its documents") reads
        // like the moderator's own ban; here it is the target's.
        targetBanned = hasConsensusCode(error, [41107]) || /is banned on contract .* and can not act on its documents/i.test(extractErrorMessage(error));
        throw error;
      }
    }, identityId, reason);
    if (targetBanned) {
      return { success: false, error: 'That identity is banned, which already bars its writes: unban it first to suspend it instead', errorCode: 'ALREADY_BANNED' };
    }
    return result;
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
    }, identityId, reason);
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
    let documentGone = false;
    const moderated = await this.moderate(moderatorId, async (sdk, auth) => {
      snapshotSaved = await this.snapshotForRestore(sdk, kind, documentId);
      try {
        await sdk.contracts.moderatorDeleteDocument({
          ...auth,
          contractId: YAPPR_CONTRACT_ID,
          documentTypeName: kind,
          documentId,
          reason: reasonOf(reason),
        });
      } catch (error) {
        // 40101: another moderator removed it first (or its author deleted it,
        // where authors can): the goal is met, and nothing was deleted here.
        documentGone = isReportGoneError(error);
        throw error;
      }
    }, undefined, reason);
    const result: ModerationResult = documentGone
      ? {
        success: false,
        error: `This ${kind} is already gone (removed by a moderator, perhaps by an earlier attempt of yours${authorDeletesLeaveHoles() ? ', or deleted by its author' : ''})`,
        errorCode: 'DOCUMENT_GONE',
      }
      : moderated;
    // The copy is the only way back, so it goes only when the network
    // DEFINITIVELY refused the delete (a classified consensus refusal, or a
    // local refusal before signing). A timeout or an unrecognised failure may
    // hide a delete that landed; the one-week expiry cleans those up. A
    // document already gone was removed after this copy was taken (by another
    // moderator, or by an earlier attempt whose answer was lost), and any
    // moderator may restore it from these bytes, so the copy stays too.
    if (!result.success && snapshotSaved && isDefinitiveRefusal(result) && result.errorCode !== 'DOCUMENT_GONE') {
      dropSnapshot(kind, documentId);
      snapshotSaved = false;
    }
    if (result.errorCode === 'DELETE_WINDOW_ELAPSED' && settledDeletionFor(kind)) {
      return { ...result, error: `${result.error}. Only the seated moderation team can remove it now, together.`, snapshotSaved };
    }
    if (result.errorCode === 'MAYBE_APPLIED') {
      return {
        ...result,
        error: `The network did not confirm in time: the ${kind} may have been removed. Check again before retrying.`,
        snapshotSaved,
      };
    }
    return { ...result, snapshotSaved };
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
    if (result.success || result.errorCode === 'ALREADY_RESTORED' || result.errorCode === 'RESTORE_WINDOW_ELAPSED'
      || result.errorCode === 'RESTORE_HASH_MISMATCH' || result.errorCode === 'SETTLED_DELETION_NOT_RESTORABLE') {
      dropSnapshot(kind, documentId);
    }
    return result;
  }

  /**
   * Proposes, as a member of the seated team, the deletion of a SETTLED post
   * or reply (past its window, v11): the proposal is the proposer's approval
   * and is kept as a team action the other members approve with
   * {@link approveTeamAction}. `reason` is required and must cite a reason
   * document the seated team's proposal lists (41203); it goes on the removal
   * record when the action runs. Resolves with the action's id and `status`:
   * `closed` when this proposal alone met the rule (the document is gone).
   * No copy is kept: a team deletion can never be restored (41209).
   */
  async proposeSettledDeletion(
    moderatorId: string,
    kind: TargetKind,
    documentId: string,
    reason: ModerationReasonInput
  ): Promise<ModerationResult & { actionId?: string; status?: ContractTeamActionStatus }> {
    if (!this.canRemove(kind) || !settledDeletionFor(kind)) {
      return { success: false, error: MODERATION_ERROR_MESSAGES.NOT_SETTLED_DELETABLE, errorCode: 'NOT_SETTLED_DELETABLE' };
    }
    if (!reason.reasonDocumentId) {
      return { success: false, error: 'A team removal must cite a reason the seated team\'s charter lists', errorCode: 'REASON_NOT_LISTED' };
    }
    let signed: { actionId: string; status: ContractTeamActionStatus } | undefined;
    const result = await this.moderate(moderatorId, async (sdk, auth) => {
      const proposal = await sdk.contracts.moderatorDeleteSettledDocument({
        ...auth,
        contractId: YAPPR_CONTRACT_ID,
        documentTypeName: kind,
        documentId,
        reason: reasonOf(reason),
      });
      signed = { actionId: proposal.actionId.toBase58(), status: proposal.status };
    }, undefined, reason);
    if (result.errorCode === 'MAYBE_APPLIED') {
      return { ...result, error: 'The network did not confirm in time: the team removal may have been proposed. Check the team actions before proposing again.' };
    }
    return signed ? { ...result, ...signed } : result;
  }

  /**
   * Approves, as a member of the seated team, an action another member
   * proposed (today, a settled deletion). Refused when it does not exist
   * (41207), this member already approved it (41208), it already ran (41210),
   * or its document changed since the proposal (41211). Resolves with its
   * `status`: `closed` when this approval met the rule and the document is gone.
   */
  async approveTeamAction(moderatorId: string, actionId: string): Promise<ModerationResult & { status?: ContractTeamActionStatus }> {
    if (!this.teamDeletesSettled()) {
      return { success: false, error: 'This contract keeps no team actions', errorCode: 'NOT_MODERATED' };
    }
    let status: ContractTeamActionStatus | undefined;
    let documentGone = false;
    const result = await this.moderate(moderatorId, async (sdk, auth) => {
      try {
        ({ status } = await sdk.contracts.moderatorApproveTeamAction({ ...auth, contractId: YAPPR_CONTRACT_ID, actionId }));
      } catch (error) {
        // 40101: the document is gone (another proposal for it ran, or its
        // author deleted it), so this action can never run.
        documentGone = isReportGoneError(error);
        throw error;
      }
    });
    if (documentGone) {
      return { success: false, error: `The document is already gone (another proposal removed it${authorDeletesLeaveHoles() ? ', or its author deleted it' : ''}), so this proposal can never run`, errorCode: 'DOCUMENT_GONE' };
    }
    if (result.errorCode === 'TEAM_ACTION_DOCUMENT_CHANGED') {
      // Any replace by its author moves `$updatedAt` (on v11 the tombstone, or a
      // replace that changes nothing), which also restarts the window in which
      // one moderator removes it alone (Drive measures it from `$updatedAt`).
      return { ...result, error: 'The document changed after this removal was proposed (its author deleted or re-saved it), so this proposal can never run. If its author deleted it, nothing is left to remove. Otherwise the change restarted its window: until that passes one moderator removes it alone, and after it, propose it again.' };
    }
    return status === undefined ? result : { ...result, status };
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

  /** {@link protectedIdentities} for the contract as it stands; empty off a moderated topology. */
  async getProtectedIdentities(): Promise<Set<string>> {
    const team = await this.getTeam();
    if (!team) return new Set();
    return protectedIdentities(team, electedModeration()?.ownerProtected === true);
  }

  /**
   * True when the contract's moderators may delete reports: v9 dismisses a
   * report this way, and v10 keeps it for purging spam reports outright (no
   * removal record) beside {@link resolveReports}.
   */
  canDismissReports(): boolean {
    return moderatorDeletableTypes().includes('report');
  }

  /** True when the moderators mark reports handled instead of deleting them (v10: `changeFields` on `report`). */
  canResolveReports(): boolean {
    return reportsAreResolved();
  }

  /**
   * Deletes reports as a moderator, one moderation transition each, in order,
   * stopping at the first refusal. On v9 each deletion leaves a removal record
   * carrying `reason` (cite the reported post in `reason.documents`, so the
   * record says what was reviewed); on v10 a report keeps no record
   * (`deleteKeepsRecord: false`) and the SDK resolves to nothing. A seated
   * elected team must also cite a charter reason (41203). The reporter gets no
   * refund. No copy is kept: a dismissed report is not restored from here.
   * A report filed by a {@link protectedIdentities protected} identity cannot
   * be deleted (41102); leave those out.
   *
   * `dismissed` lists the reports confirmed gone, also on a failure part-way.
   */
  async dismissReports(
    moderatorId: string,
    reportIds: readonly string[],
    reason: string | ModerationReasonInput,
    onDismissed?: (reportId: string) => void
  ): Promise<ModerationResult & { dismissed: string[] }> {
    const dismissed: string[] = [];
    if (!this.canDismissReports()) {
      return { success: false, error: 'Moderators cannot dismiss reports on this contract', errorCode: 'NOT_MODERATED', dismissed };
    }
    const result = await this.moderate(moderatorId, async (sdk, auth) => {
      for (const documentId of reportIds) {
        try {
          await sdk.contracts.moderatorDeleteDocument({
            ...auth,
            contractId: YAPPR_CONTRACT_ID,
            documentTypeName: 'report',
            documentId,
            reason: reasonOf(reason),
          });
        } catch (error) {
          // Withdrawn by its reporter or dismissed by another moderator since
          // the queue read it (DocumentNotFound, 40101): the goal is met, so
          // count it and go on. Anything else stops the batch as before.
          if (!isReportGoneError(error)) throw error;
        }
        dismissed.push(documentId);
        onDismissed?.(documentId);
      }
    }, undefined, reason);
    return { ...result, dismissed };
  }

  /**
   * Resolves reports (v10): writes `status` and, when given, a `resolution`
   * note on each with `moderatorChangeDocumentFields`, one moderation
   * transition each, in order, stopping at the first refusal. The report stays
   * (its reporter sees how it was handled), stamped with `$moderatedBy` and
   * `$moderatedAt`, and still expires with its 90-day ttl. A field change is
   * not refused for a protected reporter, so every report on the target can be
   * resolved, the moderator's own included. A seated elected team must cite a
   * charter reason (41203); cite the reported post in `reason.documents`.
   *
   * A report already reading exactly this way is skipped (a change that
   * changes nothing is refused, 10905), and a note the report carries that the
   * resolution leaves out is removed. A report withdrawn meanwhile (40101) or
   * past its ttl (40140) is reported in `gone`; one another moderator resolved
   * the same way meanwhile (10905) counts as resolved, and is also listed in
   * `alreadyResolved`: its `$moderatedBy`/`$moderatedAt` are that moderator's.
   *
   * `resolved` lists the reports confirmed resolved, also on a failure part-way.
   */
  async resolveReports(
    moderatorId: string,
    reports: ReadonlyArray<Pick<ReportRecord, 'id' | 'status' | 'resolution'>>,
    resolution: { status: ReportStatus; note?: string },
    reason: string | ModerationReasonInput,
    onResolved?: (reportId: string) => void
  ): Promise<ModerationResult & { resolved: string[]; alreadyResolved: string[]; gone: string[] }> {
    const resolved: string[] = [];
    const alreadyResolved: string[] = [];
    const gone: string[] = [];
    if (!this.canResolveReports()) {
      return { success: false, error: 'Moderators cannot resolve reports on this contract', errorCode: 'NOT_MODERATED', resolved, alreadyResolved, gone };
    }
    const note = resolution.note?.trim() || null;
    const result = await this.moderate(moderatorId, async (sdk, auth) => {
      /** Writes one report's resolution; false when the report is gone. */
      const write = async (report: (typeof reports)[number]): Promise<boolean> => {
        if (report.status === resolution.status && report.resolution === note) return true;
        try {
          await sdk.contracts.moderatorChangeDocumentFields({
            ...auth,
            contractId: YAPPR_CONTRACT_ID,
            documentTypeName: 'report',
            documentId: report.id,
            // `null` removes a note the report carries; an absent one is not named.
            fields: { status: resolution.status, ...(note !== null || report.resolution !== null ? { resolution: note } : {}) },
            reason: reasonOf(reason),
          });
          return true;
        } catch (error) {
          if (isReportGoneError(error) || isDocumentExpiredError(error)) return false;
          // Another moderator wrote exactly these values since the queue read it.
          if (classifyModerationError(error) === 'NOTHING_TO_CHANGE') {
            alreadyResolved.push(report.id);
            return true;
          }
          throw error;
        }
      };
      for (const report of reports) {
        if (!(await write(report))) {
          gone.push(report.id);
          continue;
        }
        resolved.push(report.id);
        onResolved?.(report.id);
      }
    }, undefined, reason);
    return { ...result, resolved, alreadyResolved, gone };
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

  /**
   * Runs one moderation write under the moderator's write lock. `reason`, when
   * the write carries one, is checked BEFORE the lock: a reason refused locally
   * (over 16 documents, over 1024 bytes) thrown inside it would carry no
   * verdict, and the lock would then hold every later write back for 15 minutes.
   */
  private async moderate(
    moderatorId: string,
    action: (sdk: EvoSDK, auth: ModeratorAuth) => Promise<void>,
    moderatedIdentityId?: string,
    reason?: string | ModerationReasonInput
  ): Promise<ModerationResult> {
    if (!contractIsModerated()) {
      return { success: false, error: 'This contract declares no moderation', errorCode: 'NOT_MODERATED' };
    }
    if (reason !== undefined) {
      try {
        reasonOf(reason);
      } catch (error) {
        return this.toResult(error);
      }
    }
    // Set once the write lock is held and the action runs: from there on a
    // failure whose answer could not be verified may hide a landed transition.
    let started = false;
    try {
      const sdk = await getEvoSdk();
      const { identity, signer } = await this.getCriticalSigner(moderatorId);
      await withSdkSignedWrite(moderatorId, YAPPR_CONTRACT_ID, () => {
        started = true;
        return action(sdk, { identity, signer });
      });
      if (moderatedIdentityId) this.standingCache.delete(moderatedIdentityId);
      return { success: true };
    } catch (error) {
      const result = this.toResult(error, started);
      // The target's standing is not what the cache says (or may have changed).
      if (moderatedIdentityId && STANDING_STALE.has(result.errorCode)) this.standingCache.delete(moderatedIdentityId);
      return result;
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

  private toResult(error: unknown, started = false): ModerationResult {
    const msg = extractErrorMessage(error);
    logger.error('Moderation failed:', msg);
    const lower = msg.toLowerCase();
    if (lower.includes('critical key required') || (lower.includes('security level') && lower.includes('critical'))) {
      return { success: false, error: 'Moderation needs your CRITICAL key to authorize', errorCode: 'NEEDS_CRITICAL_KEY' };
    }
    const kind = classifyModerationError(error) ?? (lower.includes('not a moderator') ? 'NOT_MODERATOR' : null);
    if (kind) {
      return { success: false, error: MODERATION_ERROR_MESSAGES[kind], errorCode: kind };
    }
    // A proof that failed to verify (sakura's "Quorum not found in cache"
    // while the quorum service lags a rotation) once the write started is no
    // verdict either (it may also come from a read the SDK makes before the
    // broadcast; "check again" is right for both): such a ban and such a proposal had landed. Retried
    // blind, a ban is a 41103 and a proposal a second, approval-splitting one.
    if (isTimeoutError(error) || (started && isUnverifiedOutcomeError(error))) {
      return { success: false, error: 'The network did not confirm in time: this may have been applied. Check again before retrying.', errorCode: 'MAYBE_APPLIED' };
    }
    if (hasConsensusCode(error, [41111]) || /already.{0,30}claimed.{0,30}epoch|alreadyclaimedthisepoch/.test(lower)) {
      return { success: false, error: 'The moderators pot was already paid out this epoch', errorCode: 'ALREADY_CLAIMED' };
    }
    // 41112 ContractFeesNothingToClaimError: "The <pot> fee pot of contract <c> holds nothing that can be paid out".
    if (hasConsensusCode(error, [41112]) || /nothing.{0,10}to.{0,10}claim|holds nothing that can be paid out/.test(lower)) {
      return { success: false, error: 'The moderators pot is empty', errorCode: 'NOTHING_TO_CLAIM' };
    }
    if (lower.includes('private key not found')) {
      return { success: false, error: 'No signing key for this identity', errorCode: 'INVALID_KEY' };
    }
    return { success: false, error: msg, errorCode: 'NETWORK_ERROR' };
  }
}

/** Refusals that prove the cached standing of their target stale, or may have changed it. */
const STANDING_STALE = new Set<ModerationResult['errorCode']>(['ALREADY_BANNED', 'NOT_BANNED', 'NOT_SUSPENDED', 'MAYBE_APPLIED']);

/** Document ids per `$id in` read of the team actions' targets (Drive's `in` limit). */
const TEAM_TARGETS_PER_READ = 100;

/** Team actions per page, and how many the queue reads at most. */
const TEAM_ACTIONS_PAGE = 100;
const TEAM_ACTIONS_MAX = 1000;

const reasonOf = (reason: string | ModerationReasonInput): ContractModerationReason =>
  toModerationReason(typeof reason === 'string' ? { text: reason } : reason);

/**
 * True when the action certainly did not happen: refused before signing, or
 * refused by consensus with a classified error. `MAYBE_APPLIED` and the
 * catch-all `NETWORK_ERROR` are not.
 */
function isDefinitiveRefusal(result: ModerationResult): boolean {
  return result.errorCode !== undefined && result.errorCode !== 'MAYBE_APPLIED' && result.errorCode !== 'NETWORK_ERROR';
}

const MODERATION_ERROR_MESSAGES: Record<ModerationErrorKind, string> = {
  NOT_MODERATOR: 'This identity is not one of the contract\'s moderators (on an elected contract, once a team is seated only that team moderates)',
  NOT_MODERATED: 'The contract declares no such moderation',
  TARGET_PROTECTED: 'The contract owner and its moderators cannot be moderated',
  TYPE_NOT_DELETABLE: 'Moderators cannot delete documents of this type',
  DELETE_WINDOW_ELAPSED: 'This has settled: the window in which one moderator may remove it alone has passed',
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
  FIELD_NOT_CHANGEABLE: 'Moderators cannot change that field on documents of this type',
  MODERATOR_FIELD: 'Only the moderators may set that field',
  NOTHING_TO_CHANGE: 'The document already reads that way, so there is nothing to change',
  NOT_SETTLED_DELETABLE: 'Nobody may remove documents of this type once they have settled',
  TEAM_NOT_SEATED: 'No moderation team is seated, and only a seated team can remove a settled post or reply',
  NOT_SETTLED: 'This is still within its window, so one moderator removes it directly: no team proposal is needed',
  TEAM_ACTION_NOT_FOUND: 'The team never proposed that action',
  TEAM_ACTION_ALREADY_SIGNED: 'You already approved that team action',
  SETTLED_DELETION_NOT_RESTORABLE: 'The seated team removed this together, and a team removal can never be undone',
  TEAM_ACTION_COMPLETED: 'That team action already ran',
  TEAM_ACTION_DOCUMENT_CHANGED: 'The document changed since the removal was proposed, so it can no longer be approved: propose it again',
  ALREADY_BANNED: 'That identity is already banned',
  NOT_BANNED: 'That identity is not banned',
  NOT_SUSPENDED: 'That identity is not suspended (a suspension that ran out is cleared by its next write)',
  SUSPENSION_NOT_IN_FUTURE: 'A suspension must end after the current block time: pick a later end',
  TARGET_NOT_FOUND: 'That identity does not exist',
  SELF_TARGET: 'A moderator cannot moderate itself',
  REASON_TOO_LONG: 'The reason is too long: at most 1024 bytes (characters outside ASCII take more than one)',
};

export const moderationService = new ModerationService();

