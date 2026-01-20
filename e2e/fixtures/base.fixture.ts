import { test as base, expect } from '@playwright/test';

/**
 * Base fixture with common test utilities
 */
export const test = base.extend<{
  /**
   * Clear all Yappr-related storage before each test
   */
  cleanStorage: void;
}>({
  cleanStorage: [async ({ page }, use) => {
    // Clear storage before test
    await page.addInitScript(() => {
      // Clear Yappr-specific localStorage keys
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('yappr') || key.startsWith('yappr:'))) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));

      // Clear session storage
      sessionStorage.clear();
    });

    await use();
  }, { auto: true }],
});

export { expect };

/**
 * Extended timeout for blockchain operations
 */
export const BLOCKCHAIN_TIMEOUT = 60000;

/**
 * Standard timeout for UI operations
 */
export const UI_TIMEOUT = 30000;

/**
 * Short timeout for quick checks
 */
export const SHORT_TIMEOUT = 5000;
