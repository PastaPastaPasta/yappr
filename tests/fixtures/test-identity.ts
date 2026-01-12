// Test identity for E2E tests - this is a real identity on Dash Platform
// All public interactions will be marked with #test and #automated hashtags

export const TEST_IDENTITY = {
  identityId: 'E46NuyTqWrCj1hnGN7gGdo4qCkwPdcNAN2poEZzYguzw',
  assetLockKey: 'cUoUCHGefRwpqxkFEoXkQjBa6BVNAtSEDNTmng73RvhtbkJrf7sA',
  identityKeys: [
    {
      name: 'Master (Authentication)',
      id: 0,
      purpose: 'AUTHENTICATION',
      securityLevel: 'MASTER',
      privateKeyWif: 'cTnfEvnQMjX7GM6RnrArf9N3LuU4roqeoUPLxC6H9NLTmZma1EsM',
    },
    {
      name: 'High Auth',
      id: 1,
      purpose: 'AUTHENTICATION',
      securityLevel: 'HIGH',
      privateKeyWif: 'cSgRNAvUchuWYNLm45xnLxWCrGyyysB6bcHeb8vgQHfivvGEJgMi',
    },
    {
      name: 'Critical Auth',
      id: 2,
      purpose: 'AUTHENTICATION',
      securityLevel: 'CRITICAL',
      privateKeyWif: 'cUzfneiG8JvRS4gxFdTLCJvSM8YkHtdyvqS2VLfsH4bzQzUMRtwq',
    },
    {
      name: 'Transfer',
      id: 3,
      purpose: 'TRANSFER',
      securityLevel: 'CRITICAL',
      privateKeyWif: 'cPivVm5bBneSBv9AvQrk23DC6KaGsV7GE3XaYDpYNpYcH2eJTTUD',
    },
  ],
};

// Helper to get the High Auth key (used for most operations)
export function getHighAuthKey(): string {
  return TEST_IDENTITY.identityKeys[1].privateKeyWif;
}

// Helper to generate unique test content with required hashtags
export function generateTestContent(prefix: string = 'Test'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix} ${timestamp}-${random} #test #automated`;
}

// Helper to generate unique display name for profiles
export function generateTestDisplayName(): string {
  const timestamp = Date.now();
  return `Test User ${timestamp}`;
}
