import { Page, expect } from '@playwright/test';
import { TestIdentity } from '../test-data/identities';
import { dismissPostLoginModals } from './modal.helpers';

/**
 * Login to Yappr with a test identity
 */
export async function login(page: Page, identity: TestIdentity): Promise<void> {
  // Navigate to login page
  await page.goto('/login');

  // Wait for the login form to be visible
  await page.waitForSelector('#identityInput', { timeout: 30000 });

  // Clear and type identity ID character by character to trigger React's onChange
  const identityInput = page.locator('#identityInput');
  await identityInput.clear();
  // Type the identity ID to trigger debounced lookup
  await identityInput.pressSequentially(identity.identityId, { delay: 20 });

  // Wait for the spinner to appear (indicates lookup has started)
  await page.waitForSelector('svg.animate-spin', { timeout: 10000 }).catch(() => {
    // Spinner might have already disappeared if lookup was very fast
  });

  // Wait for identity resolution with retry logic
  // The identity lookup can be slow due to blockchain queries
  await expect(async () => {
    // Check for error first
    const error = page.locator('.text-red-600, .text-red-400');
    const hasError = await error.isVisible().catch(() => false);
    if (hasError) {
      const errorText = await error.textContent();
      throw new Error(`Identity lookup failed: ${errorText}`);
    }

    // Wait for green checkmark (successful lookup)
    const checkmark = page.locator('svg.text-green-500');
    await expect(checkmark.first()).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 90000, intervals: [1000, 2000, 5000, 10000] });

  // Fill in private key (using highAuth for normal operations)
  const credentialInput = page.locator('#credential');
  await credentialInput.clear();
  await credentialInput.pressSequentially(identity.keys.highAuth, { delay: 10 });

  // Wait for key validation with retry logic
  await expect(async () => {
    const button = page.locator('button:has-text("Sign In")');
    await expect(button).toBeEnabled({ timeout: 5000 });
  }).toPass({ timeout: 60000, intervals: [1000, 2000, 5000] });

  // Click sign in
  await page.click('button:has-text("Sign In")');

  // Handle post-login modals (username registration and key backup)
  await dismissPostLoginModals(page);

  // Wait for login to complete - should redirect away from login page
  await expect(page).not.toHaveURL(/\/login/, { timeout: 60000 });

  // Wait for post-login redirects to stabilize
  // The app may redirect through /profile/create or /user before reaching final destination
  await page.waitForLoadState('domcontentloaded');

  // If we ended up on profile/create, wait for redirect to complete
  if (page.url().includes('/profile/create')) {
    await expect(page).not.toHaveURL(/\/profile\/create/, { timeout: 10000 }).catch(() => {
      // May stay on profile/create if profile needs to be created
    });
    await page.waitForLoadState('domcontentloaded');
  }
}

/**
 * Login with specific key type
 */
export async function loginWithKey(
  page: Page,
  identity: TestIdentity,
  keyType: 'masterAuth' | 'highAuth' | 'criticalAuth'
): Promise<void> {
  await page.goto('/login');

  await page.waitForSelector('#identityInput', { timeout: 30000 });

  // Clear and type identity ID to trigger React's onChange
  const identityInput = page.locator('#identityInput');
  await identityInput.clear();
  await identityInput.pressSequentially(identity.identityId, { delay: 20 });

  // Wait for spinner
  await page.waitForSelector('svg.animate-spin', { timeout: 10000 }).catch(() => {});

  // Wait for identity resolution with retry logic
  await expect(async () => {
    const error = page.locator('.text-red-600, .text-red-400');
    const hasError = await error.isVisible().catch(() => false);
    if (hasError) {
      const errorText = await error.textContent();
      throw new Error(`Identity lookup failed: ${errorText}`);
    }

    const checkmark = page.locator('svg.text-green-500');
    await expect(checkmark.first()).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 90000, intervals: [1000, 2000, 5000, 10000] });

  const credentialInput = page.locator('#credential');
  await credentialInput.clear();
  await credentialInput.pressSequentially(identity.keys[keyType], { delay: 10 });

  // Wait for button to be enabled
  await expect(async () => {
    const button = page.locator('button:has-text("Sign In")');
    await expect(button).toBeEnabled({ timeout: 5000 });
  }).toPass({ timeout: 60000, intervals: [1000, 2000, 5000] });

  await page.click('button:has-text("Sign In")');

  // Handle post-login modals
  await dismissPostLoginModals(page);

  await expect(page).not.toHaveURL(/\/login/, { timeout: 60000 });
}

// dismissPostLoginModals is now imported from modal.helpers.ts
// Re-export for backwards compatibility with any code importing from auth.helpers
export { dismissPostLoginModals } from './modal.helpers';

/**
 * Enter encryption key when prompted by the application
 * This is used after login when the app requests the encryption key
 */
export async function enterEncryptionKey(page: Page, encryptionKey: string): Promise<void> {
  // Wait for the encryption key modal/dialog
  const keyInput = page.locator('input[type="password"]').filter({
    hasText: /encryption/i
  }).or(page.locator('input[placeholder*="encryption key" i]'))
    .or(page.locator('input[placeholder*="Enter your key" i]'));

  // If a modal appears for encryption key entry, fill it
  const modal = page.locator('[role="dialog"]');
  if (await modal.isVisible({ timeout: 5000 }).catch(() => false)) {
    const passwordInputs = modal.locator('input[type="password"]');
    if (await passwordInputs.count() > 0) {
      await passwordInputs.first().fill(encryptionKey);

      // Look for confirm/submit button
      const confirmBtn = modal.locator('button:has-text("Confirm")').or(
        modal.locator('button:has-text("Submit")')
      ).or(modal.locator('button:has-text("Enter")'));

      if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
      }
    }
  }
}

/**
 * Check if currently logged in
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  // Check for presence of authenticated UI elements
  const homeLink = page.locator('a[href="/"]').or(page.locator('[data-testid="home-link"]'));
  const profileButton = page.locator('button').filter({ hasText: /profile/i });

  // If we can see navigation elements typically shown to logged-in users
  const navVisible = await homeLink.isVisible({ timeout: 2000 }).catch(() => false);
  const notOnLogin = !page.url().includes('/login');

  return navVisible && notOnLogin;
}

/**
 * Logout from the application
 */
export async function logout(page: Page): Promise<void> {
  // Look for user menu or settings that contains logout
  const userMenu = page.locator('[aria-label="User menu"]').or(
    page.locator('button').filter({ hasText: /menu/i })
  );

  if (await userMenu.isVisible()) {
    await userMenu.click();
  }

  // Click logout option
  const logoutBtn = page.locator('button:has-text("Log out")').or(
    page.locator('button:has-text("Sign out")')
  ).or(page.locator('[role="menuitem"]:has-text("Log out")'));

  if (await logoutBtn.isVisible()) {
    await logoutBtn.click();
  }

  // Alternatively, clear storage and navigate to login
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.goto('/login');
}

/**
 * Clear all Yappr-related storage
 */
export async function clearYapprStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Clear all localStorage keys starting with 'yappr'
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('yappr') || key.startsWith('yappr:'))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));

    // Clear session storage as well
    sessionStorage.clear();
  });
}

/**
 * Setup session storage for an identity (for faster test setup)
 */
export async function setupSession(page: Page, identity: TestIdentity): Promise<void> {
  await page.evaluate((id) => {
    // Store the identity ID for session
    localStorage.setItem('yappr_identity_id', id.identityId);
    localStorage.setItem('yappr_session', JSON.stringify({
      identityId: id.identityId,
      authenticatedAt: new Date().toISOString(),
    }));
  }, identity);
}
