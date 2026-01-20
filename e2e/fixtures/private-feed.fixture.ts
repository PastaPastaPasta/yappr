import { test as authTest, expect } from './auth.fixture';
import { BrowserContext, Page } from '@playwright/test';
import { TestIdentity, loadIdentity } from '../test-data/identities';
import { login } from '../helpers/auth.helpers';

/**
 * Private feed fixture for multi-user testing scenarios
 * Provides separate browser contexts for owner and followers
 */
export const test = authTest.extend<{
  /**
   * Browser context for the feed owner (identity 1)
   */
  ownerContext: BrowserContext;

  /**
   * Page for the feed owner
   */
  ownerPage: Page;

  /**
   * Browser context for follower 1 (identity 2)
   */
  followerContext: BrowserContext;

  /**
   * Page for follower 1
   */
  followerPage: Page;

  /**
   * Browser context for follower 2 (identity 3)
   */
  follower2Context: BrowserContext;

  /**
   * Page for follower 2
   */
  follower2Page: Page;

  /**
   * Login owner in their context
   */
  loginOwner: () => Promise<void>;

  /**
   * Login follower 1 in their context
   */
  loginFollower: () => Promise<void>;

  /**
   * Login follower 2 in their context
   */
  loginFollower2: () => Promise<void>;
}>({
  ownerContext: async ({ browser }, use) => {
    const context = await browser.newContext();
    await use(context);
    await context.close();
  },

  ownerPage: async ({ ownerContext }, use) => {
    const page = await ownerContext.newPage();
    await use(page);
    await page.close();
  },

  followerContext: async ({ browser }, use) => {
    const context = await browser.newContext();
    await use(context);
    await context.close();
  },

  followerPage: async ({ followerContext }, use) => {
    const page = await followerContext.newPage();
    await use(page);
    await page.close();
  },

  follower2Context: async ({ browser }, use) => {
    const context = await browser.newContext();
    await use(context);
    await context.close();
  },

  follower2Page: async ({ follower2Context }, use) => {
    const page = await follower2Context.newPage();
    await use(page);
    await page.close();
  },

  loginOwner: async ({ ownerPage, ownerIdentity }, use) => {
    const loginFn = async () => {
      await login(ownerPage, ownerIdentity);
    };
    await use(loginFn);
  },

  loginFollower: async ({ followerPage, follower1Identity }, use) => {
    const loginFn = async () => {
      await login(followerPage, follower1Identity);
    };
    await use(loginFn);
  },

  loginFollower2: async ({ follower2Page, follower2Identity }, use) => {
    const loginFn = async () => {
      await login(follower2Page, follower2Identity);
    };
    await use(loginFn);
  },
});

export { expect };
