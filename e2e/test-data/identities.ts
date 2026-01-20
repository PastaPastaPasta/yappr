import * as fs from 'fs';
import * as path from 'path';

/**
 * Test identity structure matching testing-identity-X.json files
 *
 * These files contain BASELINE state - credentials and initial setup that was
 * established when the test environment was created. They should NOT be modified
 * during test runs.
 *
 * For runtime state tracking (follower relationships, revocations, etc.),
 * use the in-memory state module: ./test-state.ts
 */
export interface TestIdentity {
  identityId: string;
  keys: {
    masterAuth: string;
    highAuth: string;
    criticalAuth: string;
    transfer: string;
    encryptionKey?: string;
  };
  balance: string;
  createdAt: string;
  // Baseline state (established at identity setup, don't modify during tests)
  privateFeedEnabled?: boolean;
  privateFeedEnabledAt?: string;
  hasProfile?: boolean;
  displayName?: string;
}

/**
 * Load a test identity from JSON file
 */
export function loadIdentity(identityNumber: 1 | 2 | 3): TestIdentity {
  const filePath = path.join(process.cwd(), `testing-identity-${identityNumber}.json`);
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Identity roles for testing
 * - owner: Identity 1 - the private feed owner
 * - follower1: Identity 2 - primary follower for access tests
 * - follower2: Identity 3 - secondary follower for revocation tests
 */
export const IDENTITY_ROLES = {
  owner: 1,
  follower1: 2,
  follower2: 3,
} as const;

export type IdentityRole = keyof typeof IDENTITY_ROLES;

/**
 * Get identity by role
 */
export function getIdentityByRole(role: IdentityRole): TestIdentity {
  return loadIdentity(IDENTITY_ROLES[role]);
}

/**
 * Check if an identity has an encryption key
 */
export function hasEncryptionKey(identity: TestIdentity): boolean {
  return !!identity.keys.encryptionKey && identity.keys.encryptionKey.length === 64;
}

/**
 * Check if an identity has private feed enabled (baseline state from file)
 *
 * Note: This checks the baseline state from the identity file. For runtime
 * state tracking, use the test-state module instead.
 */
export function hasPrivateFeedEnabledBaseline(identity: TestIdentity): boolean {
  return identity.privateFeedEnabled === true;
}
