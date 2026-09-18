// Test-only boundaries: no identity lookup, state transition, or vault write is real.
import { getEncryptionKey } from '@/lib/secure-storage'
import { scopedKey } from '@/lib/storage-scope'

export const DUMMY_IDENTITY = 'component-test-identity'
// WIF for public scalar 1. Never use with an actual identity or funds.
const EXPECTED_WIF = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA'
// WIF for public scalar 2, standing in for a key left behind by an earlier session.
const STALE_WIF = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87K7XCyj5v'
const storageKey = scopedKey(`yappr_secure_ek_${DUMMY_IDENTITY}`)
const params = new URLSearchParams(window.location.search)
const scenario = params.get('scenario')
// The sibling Requests/Followers panels are only mounted (and only given data) for the
// panel-refresh cases, so the key-persistence cases keep their exact call counts.
export const showSiblingPanels = params.get('panels') === '1'
export const REQUEST_ID = 'component-test-request'
export const REQUESTER_ID = 'component-test-requester'
export const FOLLOWER_ID = 'component-test-follower'
const user = { identityId: DUMMY_IDENTITY }
const state = {
  enabled: params.get('enabled') === '1',
  statusReads: 0,
  enableCalls: 0,
  storageWriteFailures: 0,
  vaultCalls: 0,
  vaultHadLocalKey: false,
  vaultReceivedCanonicalKey: false,
  requestLoads: 0,
  followerLoads: 0,
  revokeCalls: 0,
}

// The stale-key scenario seeds a different key for this identity first, so the swallowed
// write failure leaves a non-null readback that does not match the accepted key.
if (scenario === 'stale-key') {
  localStorage.setItem(storageKey, JSON.stringify(STALE_WIF))
}

if (scenario === 'storage-failure' || scenario === 'stale-key') {
  const originalSetItem = Storage.prototype.setItem
  Storage.prototype.setItem = function (key: string, value: string) {
    if (this === localStorage && key === storageKey) {
      state.storageWriteFailures += 1
      throw new DOMException('Synthetic key write failure', 'QuotaExceededError')
    }
    originalSetItem.call(this, key, value)
  }
}

export function snapshot() {
  const stored = getEncryptionKey(DUMMY_IDENTITY)
  return {
    ...state,
    keyAbsent: stored === null,
    hasCanonicalLocalKey: stored === EXPECTED_WIF,
    hasStaleLocalKey: stored === STALE_WIF,
    hasPersistedCanonicalKey: localStorage.getItem(storageKey) === JSON.stringify(EXPECTED_WIF),
  }
}

export function useAuth() {
  return {
    user,
    mergeSecretsIntoAuthVault: async (identityId: string, secrets: { encryptionKeyWif: string }) => {
      state.vaultCalls += 1
      state.vaultHadLocalKey = getEncryptionKey(identityId) === EXPECTED_WIF
      state.vaultReceivedCanonicalKey = identityId === DUMMY_IDENTITY && secrets.encryptionKeyWif === EXPECTED_WIF
      if (scenario === 'vault-failure') throw new Error('Synthetic vault backup failure')
    },
  }
}

export const TREE_CAPACITY = 65536
export const MAX_EPOCH = 65535
export const privateFeedService = {
  getPrivateFeedState: async () => {
    state.statusReads += 1
    return state.enabled ? { $createdAt: 1700000000000 } : null
  },
  enablePrivateFeed: async () => {
    state.enableCalls += 1
    state.enabled = true
    return { success: true }
  },
  getLatestEpoch: async () => 1,
  hasPrivateFeed: async () => state.enabled,
  getPrivateFollowers: async () => {
    state.followerLoads += 1
    // The grant stays queryable after a revoke on purpose: revokeFollower tolerates an
    // unconfirmed grant deletion, so a reload must not be able to resurrect the follower.
    return showSiblingPanels && state.enabled
      ? [{ recipientId: FOLLOWER_ID, leafIndex: 0, grantedAt: 1700000000000 }]
      : []
  },
  revokeFollower: async () => {
    state.revokeCalls += 1
    return { success: true }
  },
}
export const privateFeedFollowerService = {
  getFollowRequestsForOwner: async () => {
    state.requestLoads += 1
    // Likewise on chain and therefore returned by every reload, ignored or not.
    return showSiblingPanels && state.enabled
      ? [{ $id: REQUEST_ID, $ownerId: REQUESTER_ID, $createdAt: 1700000000000 }]
      : []
  },
}
export const resolveUserDetailsBatch = async (identityIds: string[]) =>
  new Map(identityIds.map(id => [id, { id, displayName: `User ${id.slice(-6)}`, hasDpns: false }]))
export const UserAvatar = () => null
export const privateFeedKeyStore = { hasFeedSeed: () => false, getRecipientMap: () => ({}) }
export const identityService = { hasEncryptionKey: async () => true }
export const validateEncryptionKey = async () => ({
  isValid: true,
  privateKey: Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0),
})
export const useEncryptionKeyModal = () => ({ open: () => undefined })
export const ResetPrivateFeedDialog = () => null
export const AddEncryptionKeyModal = () => null
