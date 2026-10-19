import { create } from 'zustand'
import { reconcileFeePot } from '../../lib/reconcile-fee-pot'
import type { PasskeyEntryView } from '@/lib/auth/passkey-vault'

const user = { identityId: 'offline-identity', dpnsUsername: 'alice.dash' }
export function useAuth() {
  return { user, controller: { getState: () => ({ user: { username: 'alice.dash' } }) }, refreshDpnsUsernames: async () => undefined, login: async () => undefined }
}
// These offline views mock the signer; payout tests model an authorized moderator.
export function useModerationAuthorization() {
  return new URLSearchParams(location.search).get('authorization') !== 'wallet'
}
export function useModerationRole() {
  return { isModerator: true, isProtected: false, protectedIds: new Set<string>() }
}
export const entry: PasskeyEntryView = { entryId: 'removed-id', credentialId: 'credential', updatedAt: 1700000000000, name: null, marker: 'marker', addedAt: 1700000000000, thisDevice: true, needsUpdate: false }
export async function listPasskeys() { return [entry] } // A node still behind the confirmed delete.
export async function passkeyEligibility() { return null }
export async function removePasskeys() { return { removed: 1, failed: 0 } }
export function passkeysOffered() { return true }
export function walletPasskeysPossible() { return true }
export function hasAppConnectSession() { return false }
export class PasskeyVaultError extends Error { code = 'failed' }
export const useAppConnectStatus = create(() => ({ identityId: null }))
export function useModeratedTypeOpen() { return true }
export function ProfileImageUpload() { return null }
export function reportModerationRefusal() { return false }
export const blogService = { getBlogTimelinePage: async () => ({ blogs: [{ id: 'delete-me', ownerId: 'author', name: 'Stale discovery blog', createdAt: new Date() }] }), getMany: async () => [], createBlog: async () => { throw new Error('No writes in this fixture') } }
export const keyValidationService = {}
export const identityService = {}
export const dpnsService = { resolveUsernamesBatch: async () => new Map() }

export function useSdk() { return { isReady: true, error: null } }
export { electionView } from '../../lib/services/moderation-election-service'
import { moderatedContract } from '@/lib/moderated-contracts'
import type { ElectionStatus } from '@/lib/services/moderation-election-service'
const fullId = 'Hga7gpqFN123hqkNueaeKvV6GVJgvJWpyYuuCXpe6J4m'
export const moderationElectionService = { async getStatus(): Promise<ElectionStatus> {
  const declaration = moderatedContract('social').elected()
  if (!declaration) throw new Error('Missing elected fixture declaration')
  return { targetContractId: fullId, declaration, failures: [], seatedReasons: [],
    seated: { leaderId: fullId, members: [fullId], electedCharterId: fullId, submittedCharterId: fullId },
    contest: { contenders: [{ identityId: fullId, votes: 123456 }], abstainVotes: 0, lockVotes: 0, endsAtMs: 1700000000000,
      winner: { kind: 'identity', identityId: fullId, decidedAtMs: 1700000000000 } },
    proposals: [{ id: fullId, leaderId: fullId, description: 'Fixture proposal', reasonIds: [], moderatorsShare: 80, rewardSplit: null, createdAt: 1700000000000 }],
  }
} }
export function useBlogFollow() { return { isFollowing: false, isLoading: false, toggleFollow: async () => undefined } }
export const blogPostService = {}

export const blogFollowService = { getFollowStatusBatch: async () => new Map() }

export function CharterReasonPicker() { return null }
export function useSeatedReasons() { return { required: false, failed: false, loading: false, reasons: [] } }
export function ContractReportQueue() { return null }
export function ReportQueue() { return null }
export function TeamActionsPanel() { return null }
export function postedOnLabel() { return '' }
let claimed = false
let historyEpoch: number | null = null
export function exposePayoutHistory() { historyEpoch = 123 }
export function exposeIntermediatePayoutHistory() { historyEpoch = 122 }
const moderation = {
  isSettled: () => false,
  canWarn: () => false,
  contract: { countsActions: () => false },
  listEntries: async () => ({ entries: [] }),
  listRemovals: async () => ({ removals: [] }),
  canRestore: () => false,
  getFeePots: async () => ({ moderators: historyEpoch === null
    ? { credits: 100000000n, lastClaimEpoch: null, lastClaimantId: null }
    : { credits: historyEpoch === 123 ? 0n : 80000000n, lastClaimEpoch: historyEpoch, lastClaimantId: 'offline-identity' } }),
  // This fixture checks the view/service contract; real epoch filtering has service unit coverage.
  moderatorsPotStatus: () => ({
    pot: claimed
      ? { credits: 0n, lastClaimEpoch: 123, lastClaimantId: 'offline-identity' }
      : { credits: 100000000n, lastClaimEpoch: null, lastClaimantId: null },
    pending: claimed && historyEpoch !== 123,
  }),
  reconcileModeratorsPot: async () => {
    if (!claimed) return
    await reconcileFeePot(async () => (await moderation.getFeePots()).moderators, 123)
  },
  claimModeratorsPot: async () => { if (claimed) throw new Error('Duplicate fixture payout'); claimed = true; return { success: true, remainingCredits: 0n } },
}
export function moderationServiceFor() { return moderation }

export const followService = { isFollowing: async () => false }
export const unifiedProfileService = { getProfile: async () => null, getAvatarUrl: async () => null }
export async function loadUserStats() { return { followers: 0, following: 0, posts: 0 } }
export async function loadIdentityBatch() { return { usernames: new Map(), avatars: new Map() } }
export const blogCommentService = { getCommentsByPost: async () => [] }

export function PageShell({ children }: { children: import('react').ReactNode }) { return <div>{children}</div> }
export function PageHeader() { return null }
