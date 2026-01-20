import { test, expect } from '../fixtures/auth.fixture';

/**
 * Setup verification tests
 * These tests verify that the E2E testing infrastructure is working correctly
 */
test.describe('Setup Verification', () => {
  // Log console messages for debugging
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.log(`Browser ${msg.type()}: ${msg.text()}`);
      }
    });
  });

  test('should have test identities loaded', async ({ ownerIdentity, follower1Identity, follower2Identity }) => {
    // Verify owner identity
    expect(ownerIdentity.identityId).toBeTruthy();
    expect(ownerIdentity.keys.highAuth).toBeTruthy();

    // Verify follower 1 identity
    expect(follower1Identity.identityId).toBeTruthy();
    expect(follower1Identity.keys.highAuth).toBeTruthy();

    // Verify follower 2 identity
    expect(follower2Identity.identityId).toBeTruthy();
    expect(follower2Identity.keys.highAuth).toBeTruthy();

    // All three should be different
    expect(ownerIdentity.identityId).not.toBe(follower1Identity.identityId);
    expect(ownerIdentity.identityId).not.toBe(follower2Identity.identityId);
    expect(follower1Identity.identityId).not.toBe(follower2Identity.identityId);
  });

  test('should be able to navigate to login page', async ({ page }) => {
    await page.goto('/login');
    // URL may have trailing slash
    await expect(page).toHaveURL(/\/login\/?$/);

    // Verify login form is visible (using actual input IDs from login page)
    await expect(page.locator('#identityInput')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#credential')).toBeVisible({ timeout: 30000 });
  });

  test('should be able to login with owner identity', async ({ page, ownerIdentity, loginAs }) => {
    await loginAs(ownerIdentity);

    // Should no longer be on login page
    await expect(page).not.toHaveURL(/\/login/);
  });
});
