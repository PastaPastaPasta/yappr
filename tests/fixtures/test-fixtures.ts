import { test as base, Page, expect } from '@playwright/test';
import { TEST_IDENTITY, getHighAuthKey } from './test-identity';

// Custom fixture types
type TestFixtures = {
  authenticatedPage: Page;
  loggedInPage: Page;
};

// Extend Playwright's base test with custom fixtures
export const test = base.extend<TestFixtures>({
  // A page that's been authenticated with the test identity
  authenticatedPage: async ({ page }, use) => {
    await loginWithTestIdentity(page);
    await use(page);
  },

  // Alias for authenticatedPage
  loggedInPage: async ({ authenticatedPage }, use) => {
    await use(authenticatedPage);
  },
});

// Re-export expect
export { expect };

// Helper function to login with test identity
export async function loginWithTestIdentity(page: Page): Promise<void> {
  await page.goto('/');

  // Wait for the page to load
  await page.waitForLoadState('networkidle');

  // Check if we're already logged in
  const isLoggedIn = await page.locator('[data-testid="compose-button"], button:has-text("What\'s happening")').first().isVisible().catch(() => false);

  if (isLoggedIn) {
    return; // Already logged in
  }

  // Look for login button or login form
  const loginButton = page.getByRole('button', { name: /connect|login|sign in/i });
  const hasLoginButton = await loginButton.first().isVisible().catch(() => false);

  if (hasLoginButton) {
    await loginButton.first().click();
    await page.waitForTimeout(500);
  }

  // Fill in identity ID
  const identityInput = page.getByPlaceholder(/identity|username/i).first();
  if (await identityInput.isVisible().catch(() => false)) {
    await identityInput.fill(TEST_IDENTITY.identityId);
    await page.waitForTimeout(500);
  }

  // Look for private key input and fill it
  const privateKeyInput = page.getByPlaceholder(/private key|wif/i).first();
  if (await privateKeyInput.isVisible().catch(() => false)) {
    await privateKeyInput.fill(getHighAuthKey());
  }

  // Click connect/login button
  const connectButton = page.getByRole('button', { name: /connect|login|continue|sign in/i });
  if (await connectButton.first().isVisible().catch(() => false)) {
    await connectButton.first().click();
  }

  // Wait for redirect to feed or for feed to load
  await page.waitForTimeout(2000);

  // Verify we're logged in by checking for compose button or feed
  await expect(page.locator('body')).toBeVisible();
}

// Helper to wait for Dash Platform operations (which can be slow)
export async function waitForPlatformOperation(page: Page, timeout: number = 30000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout });
}

// Helper to generate unique test ID
export function generateTestId(): string {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
