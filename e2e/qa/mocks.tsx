import { create } from 'zustand'
import type { PasskeyEntryView } from '@/lib/auth/passkey-vault'

const user = { identityId: 'offline-identity', dpnsUsername: 'alice.dash' }
export function useAuth() {
  return { user, controller: { getState: () => ({ user: { username: 'alice.dash' } }) }, refreshDpnsUsernames: async () => undefined, login: async () => undefined }
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
let historyVisible = false
export function exposePayoutHistory() { historyVisible = true }
const moderation = {
  canWarn: () => false,
  contract: { countsActions: () => false },
  listEntries: async () => ({ entries: [] }),
  listRemovals: async () => ({ removals: [] }),
  canRestore: () => false,
  getFeePots: async () => ({ moderators: historyVisible
    ? { credits: 0n, lastClaimEpoch: 123, lastClaimantId: 'offline-identity' }
    : { credits: 100000000n, lastClaimEpoch: null, lastClaimantId: null } }),
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
