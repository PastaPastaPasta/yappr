/**
 * In-memory test state tracking
 *
 * This module tracks runtime state during test execution without persisting
 * to disk. The blockchain is the source of truth - this is just for tracking
 * what happened during the current test run.
 *
 * State is reset at the start of each full test run via global-setup.ts
 */

export interface IdentityState {
  // Private feed status
  privateFeedEnabled?: boolean;
  privateFeedEnabledAt?: string;

  // Follower relationships
  isPrivateFollowerOf?: string;
  privateFeedApprovedAt?: string;

  // Revocation tracking
  revokedFromPrivateFeed?: string;
  revokedAt?: string;
  accessRevokedByReset?: boolean;

  // Epoch tracking (for owner)
  lastRevocationEpoch?: number;
  lastResetAt?: string;

  // Blocking relationships
  blockedBy?: string;
  blockedByFollower?: string;

  // Profile info
  hasProfile?: boolean;
  displayName?: string;
}

interface TestRunState {
  identities: {
    1: IdentityState;
    2: IdentityState;
    3: IdentityState;
  };
}

// Singleton state for the test run
let state: TestRunState = {
  identities: {
    1: {},
    2: {},
    3: {},
  },
};

/**
 * Reset all test state (called at start of test run)
 */
export function resetTestState(): void {
  state = {
    identities: {
      1: {},
      2: {},
      3: {},
    },
  };
}

/**
 * Get state for a specific identity
 */
export function getIdentityState(identityNumber: 1 | 2 | 3): IdentityState {
  return state.identities[identityNumber];
}

/**
 * Update state for a specific identity
 */
export function updateIdentityState(
  identityNumber: 1 | 2 | 3,
  updates: Partial<IdentityState>
): void {
  state.identities[identityNumber] = {
    ...state.identities[identityNumber],
    ...updates,
  };
}

/**
 * Mark identity as having private feed enabled
 */
export function markPrivateFeedEnabled(identityNumber: 1 | 2 | 3): void {
  updateIdentityState(identityNumber, {
    privateFeedEnabled: true,
    privateFeedEnabledAt: new Date().toISOString().split('T')[0],
  });
}

/**
 * Mark identity as a private follower of another identity
 */
export function markAsPrivateFollower(
  followerIdentityNumber: 1 | 2 | 3,
  ownerIdentityId: string
): void {
  updateIdentityState(followerIdentityNumber, {
    isPrivateFollowerOf: ownerIdentityId,
    privateFeedApprovedAt: new Date().toISOString().split('T')[0],
  });
}

/**
 * Mark identity as revoked from a private feed
 */
export function markAsRevoked(
  followerIdentityNumber: 1 | 2 | 3,
  ownerIdentityId: string
): void {
  const currentState = getIdentityState(followerIdentityNumber);
  updateIdentityState(followerIdentityNumber, {
    isPrivateFollowerOf: undefined, // Clear follower status
    revokedFromPrivateFeed: ownerIdentityId,
    revokedAt: new Date().toISOString().split('T')[0],
  });
}

/**
 * Increment revocation epoch for owner
 */
export function incrementRevocationEpoch(ownerIdentityNumber: 1 | 2 | 3): void {
  const currentState = getIdentityState(ownerIdentityNumber);
  updateIdentityState(ownerIdentityNumber, {
    lastRevocationEpoch: (currentState.lastRevocationEpoch || 1) + 1,
  });
}

/**
 * Mark that owner reset their private feed
 */
export function markPrivateFeedReset(ownerIdentityNumber: 1 | 2 | 3): void {
  updateIdentityState(ownerIdentityNumber, {
    lastResetAt: new Date().toISOString().split('T')[0],
    lastRevocationEpoch: 1, // Reset to epoch 1
  });
}

/**
 * Mark that a follower's access was revoked due to reset
 */
export function markAccessRevokedByReset(followerIdentityNumber: 1 | 2 | 3): void {
  updateIdentityState(followerIdentityNumber, {
    isPrivateFollowerOf: undefined,
    accessRevokedByReset: true,
  });
}

/**
 * Mark identity as blocked by another
 */
export function markAsBlocked(
  blockedIdentityNumber: 1 | 2 | 3,
  blockerIdentityId: string
): void {
  updateIdentityState(blockedIdentityNumber, {
    blockedBy: blockerIdentityId,
  });
}

/**
 * Mark that owner was blocked by a follower
 */
export function markBlockedByFollower(
  ownerIdentityNumber: 1 | 2 | 3,
  followerIdentityId: string
): void {
  updateIdentityState(ownerIdentityNumber, {
    blockedByFollower: followerIdentityId,
  });
}

/**
 * Mark identity as having a profile
 */
export function markHasProfile(
  identityNumber: 1 | 2 | 3,
  displayName: string
): void {
  updateIdentityState(identityNumber, {
    hasProfile: true,
    displayName,
  });
}

/**
 * Check if identity has private feed enabled (in current run)
 */
export function isPrivateFeedEnabled(identityNumber: 1 | 2 | 3): boolean {
  return getIdentityState(identityNumber).privateFeedEnabled === true;
}

/**
 * Check if identity is a private follower (in current run)
 */
export function isPrivateFollowerOf(
  followerIdentityNumber: 1 | 2 | 3,
  ownerIdentityId: string
): boolean {
  return getIdentityState(followerIdentityNumber).isPrivateFollowerOf === ownerIdentityId;
}

/**
 * Check if identity was revoked (in current run)
 */
export function wasRevoked(followerIdentityNumber: 1 | 2 | 3): boolean {
  return !!getIdentityState(followerIdentityNumber).revokedFromPrivateFeed;
}
