import { test as baseTest, expect, Page } from '@playwright/test';
import { TestIdentity, loadIdentity, getIdentityByRole, IdentityRole } from '../test-data/identities';
import { login, loginWithKey, clearYapprStorage } from '../helpers/auth.helpers';

/**
 * Authentication fixture that provides login capabilities
 */
export const test = baseTest.extend<{
  /**
   * Login with a specific identity
   */
  loginAs: (identity: TestIdentity) => Promise<void>;

  /**
   * Login with a specific identity role (owner, follower1, follower2)
   */
  loginAsRole: (role: IdentityRole) => Promise<void>;

  /**
   * Login with specific key type
   */
  loginWithKeyType: (identity: TestIdentity, keyType: 'masterAuth' | 'highAuth' | 'criticalAuth') => Promise<void>;

  /**
   * Clear Yappr storage
   */
  clearStorage: () => Promise<void>;

  /**
   * Pre-loaded identities for convenience
   */
  ownerIdentity: TestIdentity;
  follower1Identity: TestIdentity;
  follower2Identity: TestIdentity;
}>({
  loginAs: async ({ page }, use) => {
    const loginFn = async (identity: TestIdentity) => {
      await login(page, identity);
    };
    await use(loginFn);
  },

  loginAsRole: async ({ page }, use) => {
    const loginFn = async (role: IdentityRole) => {
      const identity = getIdentityByRole(role);
      await login(page, identity);
    };
    await use(loginFn);
  },

  loginWithKeyType: async ({ page }, use) => {
    const loginFn = async (identity: TestIdentity, keyType: 'masterAuth' | 'highAuth' | 'criticalAuth') => {
      await loginWithKey(page, identity, keyType);
    };
    await use(loginFn);
  },

  clearStorage: async ({ page }, use) => {
    const clearFn = async () => {
      await clearYapprStorage(page);
    };
    await use(clearFn);
  },

  ownerIdentity: async ({}, use) => {
    await use(loadIdentity(1));
  },

  follower1Identity: async ({}, use) => {
    await use(loadIdentity(2));
  },

  follower2Identity: async ({}, use) => {
    await use(loadIdentity(3));
  },
});

export { expect };
