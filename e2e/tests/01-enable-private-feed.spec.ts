import { test, expect } from '../fixtures/auth.fixture';
import { goToPrivateFeedSettings, waitForToast } from '../helpers/navigation.helpers';
import { loadIdentity } from '../test-data/identities';
import { markPrivateFeedEnabled, isPrivateFeedEnabled } from '../test-data/test-state';

/**
 * Test Suite: Enable Private Feed
 * Reference: YAPPR_PRIVATE_FEED_E2E_TESTS.md §1 & e2e_prd.md §7 (P0)
 *
 * Tests the private feed enablement flow:
 * - 1.1 Happy path with encryption key
 * - 1.2 Missing encryption key (identity 3 has no key)
 * - 1.3 Already enabled (identity 1 already has private feed)
 */
test.describe('01 - Enable Private Feed', () => {
  // Log console errors for debugging
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`Browser error: ${msg.text()}`);
      }
    });
  });

  /**
   * Test 1.1: Enable Private Feed - Happy Path
   *
   * Preconditions:
   * - User is logged in with encryption key
   * - User has NOT enabled private feed
   *
   * Uses follower1Identity (Identity 2) which has encryption key but no private feed enabled
   */
  test('1.1 Enable Private Feed - Happy Path', async ({ page, follower1Identity, loginAs }) => {
    // Login as follower1 (has encryption key, no private feed yet)
    await loginAs(follower1Identity);

    // Navigate to private feed settings
    await goToPrivateFeedSettings(page);

    // Wait for the page to load
    await page.waitForLoadState('networkidle');

    // Verify "Enable Private Feed" button is visible
    const enableBtn = page.locator('button:has-text("Enable Private Feed")');
    await expect(enableBtn).toBeVisible({ timeout: 30000 });

    // Verify capacity info is shown (1,024 followers)
    await expect(page.locator('text=1,024')).toBeVisible();

    // Click "Enable Private Feed"
    await enableBtn.click();

    // The flow shows an inline key input form (not a modal)
    // Wait for the encryption key input to appear
    const keyInput = page.locator('input[type="password"]');
    await expect(keyInput).toBeVisible({ timeout: 10000 });

    // Verify the warning message about encryption key
    await expect(page.locator('text=Encryption key required')).toBeVisible();

    // Enter the encryption key
    await keyInput.fill(follower1Identity.keys.encryptionKey!);

    // Click the Enable button in the form
    const confirmBtn = page.locator('button:has-text("Enable")').last();
    await confirmBtn.click();

    // Wait for success toast - blockchain operations can be slow
    await waitForToast(page);

    // Verify private feed is now enabled - check for enabled state indicators
    await expect(page.locator('text=Private feed is enabled')).toBeVisible({ timeout: 60000 });

    // Verify dashboard stats are shown with initial values
    // Should show: Followers: 0/1024, Available Slots
    await expect(page.locator('text=/\\d+\\s*\\/\\s*1,?024/').first()).toBeVisible({ timeout: 10000 });

    // Track that private feed is now enabled (in-memory state)
    markPrivateFeedEnabled(2);
  });

  /**
   * Test 1.2: Enable Private Feed - Missing Encryption Key
   *
   * Preconditions:
   * - User is logged in
   * - User has NO encryption key on identity
   *
   * Uses follower2Identity (Identity 3) which has NO encryption key in local file.
   * This test verifies the UI behavior when encryption key is missing.
   *
   * Note: The UI loads async - it may show "Enable Private Feed" initially,
   * then switch to "Add Encryption Key" after checking the identity on-chain.
   */
  test('1.2 Enable Private Feed - Missing Encryption Key', async ({ page, follower2Identity, loginAs }) => {
    // Login as follower2 (no encryption key in local file)
    await loginAs(follower2Identity);

    // Navigate to private feed settings
    await goToPrivateFeedSettings(page);

    // Wait for the page to load completely
    await page.waitForLoadState('networkidle');

    // Wait a bit longer for the async identity key check to complete
    await page.waitForTimeout(3000);

    // The UI should either:
    // 1. Show "Add Encryption Key to Identity" button (if no key on identity)
    // 2. Show "Enable Private Feed" button (if user somehow has key on identity)
    // 3. The enable flow should be blocked if key is missing

    const addKeyBtn = page.locator('button:has-text("Add Encryption Key to Identity")');
    const enableBtn = page.locator('button:has-text("Enable Private Feed")');

    const addKeyVisible = await addKeyBtn.isVisible().catch(() => false);
    const enableBtnVisible = await enableBtn.isVisible().catch(() => false);

    if (addKeyVisible) {
      // Case 1: User has no encryption key on identity - expected behavior
      // Verify the warning message is shown
      await expect(page.locator('text=Encryption key required')).toBeVisible();

      // Clicking the button should open a modal to add encryption key
      await addKeyBtn.click();

      // Modal should appear
      await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 10000 });
    } else if (enableBtnVisible) {
      // Case 2: User may have encryption key on identity (added previously)
      // Try to enable and verify the flow asks for the key

      await enableBtn.click();

      // Should show key input form
      const keyInput = page.locator('input[type="password"]');
      await expect(keyInput).toBeVisible({ timeout: 10000 });

      // Verify warning about encryption key - use .first() to avoid strict mode
      await expect(page.getByText('Encryption key required').first()).toBeVisible();

      // Try entering an invalid key or no key
      // The enable button should be disabled when no key entered
      const confirmBtn = page.locator('button:has-text("Enable")').last();
      await expect(confirmBtn).toBeDisabled();
    } else {
      // Neither button visible - unexpected state
      throw new Error('Neither "Add Encryption Key" nor "Enable Private Feed" button found');
    }
  });

  /**
   * Test 1.3: Enable Private Feed - Already Enabled
   *
   * Preconditions:
   * - User has private feed already enabled
   *
   * Uses ownerIdentity (Identity 1) which has private feed already enabled
   */
  test('1.3 Enable Private Feed - Already Enabled', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner (has private feed enabled)
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToPrivateFeedSettings(page);

    // Wait for the page to load
    await page.waitForLoadState('networkidle');

    // Dashboard should be shown (not enable button)
    // Use .first() to avoid strict mode violation since text appears in multiple places
    await expect(page.getByText('Private feed is enabled').first()).toBeVisible({ timeout: 30000 });

    // Enable button should NOT be visible
    const enableBtn = page.locator('button:has-text("Enable Private Feed")');
    await expect(enableBtn).not.toBeVisible({ timeout: 5000 });

    // Stats should display current state
    // Check for follower count display - the stat card shows "Followers" label
    await expect(page.locator('text=Followers').first()).toBeVisible({ timeout: 10000 });

    // Should see management options - Reset Private Feed is in danger zone
    await expect(page.locator('button:has-text("Reset Private Feed")').first()).toBeVisible({ timeout: 10000 });

    // Verify the dashboard cards are present
    // Check for epoch display (shows current epoch / max)
    await expect(page.locator('text=Epoch').first()).toBeVisible({ timeout: 10000 });
  });
});
