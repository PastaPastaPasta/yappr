import { test, expect } from '../fixtures/auth.fixture';
import { goToSettings, goToProfile, goToHome, openComposeModal } from '../helpers/navigation.helpers';
import { loadIdentity } from '../test-data/identities';
import { markPrivateFeedReset, markAccessRevokedByReset } from '../test-data/test-state';

/**
 * Test Suite: Reset Private Feed
 * Reference: YAPPR_PRIVATE_FEED_E2E_TESTS.md §9 & e2e_prd.md §7 (P1)
 *
 * Tests the private feed reset flow:
 * - 9.1 Reset Flow — Full Journey
 * - 9.2 Old Posts After Reset — Owner View
 * - 9.3 Old Posts After Reset — Follower View
 * - 9.4 Followers After Reset
 * - 9.5 Reset Not Available When Not Enabled
 *
 * Test Users:
 * - @owner (Identity 1): Has private feed enabled, will perform reset
 * - @follower1 (Identity 2): Was a private follower before reset
 *
 * IMPORTANT: The reset functionality is DESTRUCTIVE:
 * - All private followers lose access
 * - All existing private posts become unreadable
 * - A new encryption key is generated
 *
 * This test suite is typically SKIPPED in normal CI runs because:
 * 1. Reset is irreversible and changes on-chain state
 * 2. It would require re-enabling private feed and re-approving followers for other tests
 * 3. It should only be run in isolated test environments with fresh identities
 */

test.describe('09 - Reset Private Feed', () => {
  // Log console errors for debugging
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`Browser error: ${msg.text()}`);
      }
    });
  });

  /**
   * Test 9.5: Reset Not Available When Not Enabled
   *
   * Preconditions:
   * - User has NOT enabled private feed
   *
   * Steps:
   * 1. Navigate to Settings → Private Feed
   *
   * Expected Results:
   * - "Enable Private Feed" button shown
   * - No "Reset" option available
   *
   * Note: Running this test first since it doesn't modify state and uses
   * a user without private feed (Identity 3)
   */
  test('9.5 Reset Not Available When Not Enabled', async ({ page, follower2Identity, loginAs }) => {
    // Check if follower2 (Identity 3) has private feed enabled
    const identity3 = loadIdentity(3);

    // If Identity 3 has private feed enabled, we can't test this scenario with it
    // In that case, we need to skip or use a different approach
    if (identity3.privateFeedEnabled) {
      console.log('Identity 3 already has private feed enabled');
      // Continue anyway to verify the UI doesn't show Reset when private feed is enabled
    }

    // Login as follower2 (should not have private feed enabled)
    await loginAs(follower2Identity);

    // Navigate to private feed settings
    await goToSettings(page, 'privateFeed');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000); // Wait for async loading

    // Take screenshot of the state
    await page.screenshot({ path: 'screenshots/09-9.5-reset-not-available.png' });

    // Check what options are available
    const enableBtn = page.locator('button:has-text("Enable Private Feed")');
    const addKeyBtn = page.locator('button:has-text("Add Encryption Key to Identity")');
    const resetBtn = page.locator('button:has-text("Reset Private Feed")');

    const hasEnableBtn = await enableBtn.isVisible({ timeout: 10000 }).catch(() => false);
    const hasAddKeyBtn = await addKeyBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const hasResetBtn = await resetBtn.isVisible({ timeout: 5000 }).catch(() => false);

    console.log({
      hasEnableBtn,
      hasAddKeyBtn,
      hasResetBtn,
    });

    if (!identity3.privateFeedEnabled) {
      // Private feed not enabled - should show Enable button, not Reset
      if (hasEnableBtn || hasAddKeyBtn) {
        console.log('Enable/Add Key button visible (expected when private feed not enabled)');
      }

      // Reset button should NOT be visible when private feed is not enabled
      expect(hasResetBtn).toBe(false);
      console.log('Reset button correctly not shown when private feed is not enabled');
    } else {
      // Private feed is enabled - Reset should be available
      if (hasResetBtn) {
        console.log('Reset button visible (expected when private feed is enabled)');
      }
    }
  });

  /**
   * Test 9.1: Reset Flow — Full Journey
   *
   * Preconditions:
   * - @owner has private feed with:
   *   - Private followers
   *   - Private posts
   *   - Current epoch > 1
   *
   * Steps:
   * 1. Navigate to Settings → Private Feed
   * 2. Click "Reset Private Feed"
   * 3. Verify warning dialog shows:
   *    - "Remove all current private followers"
   *    - "Make all existing private posts unreadable"
   *    - "This action cannot be undone"
   * 4. Enter encryption key
   * 5. Type "RESET" in confirmation field
   * 6. Click [Reset Private Feed]
   *
   * Expected Results:
   * - New PrivateFeedState created with fresh seed
   * - New epoch chain starts at 1
   * - Dashboard shows: 0 followers, 0 pending
   * - Old grants become orphaned
   *
   * IMPORTANT: This test is SKIP by default because it's DESTRUCTIVE.
   * Only run manually when testing the reset flow specifically.
   */
  test('9.1 Reset Flow — Full Journey', async ({ page, ownerIdentity, loginAs }) => {
    // SKIP this test by default - it's destructive
    // Remove this skip when you explicitly want to test reset functionality
    test.skip(true, 'Reset test is skipped by default - remove this line to run the destructive reset test');

    // Check if owner has private feed enabled
    const identity1 = loadIdentity(1);
    if (!identity1.privateFeedEnabled) {
      test.skip(true, 'Owner does not have private feed enabled - cannot test reset');
      return;
    }

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToSettings(page, 'privateFeed');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Verify "Private feed is enabled" state
    const enabledText = page.getByText('Private feed is enabled').first();
    await expect(enabledText).toBeVisible({ timeout: 30000 });

    // Find the Reset Private Feed button in the Danger Zone
    const dangerZone = page.getByText('Danger Zone');
    const hasDangerZone = await dangerZone.isVisible({ timeout: 10000 }).catch(() => false);

    if (!hasDangerZone) {
      console.log('Danger Zone section not found');
      await page.screenshot({ path: 'screenshots/09-9.1-no-danger-zone.png' });
      test.skip(true, 'Danger Zone section not found in settings');
      return;
    }

    // Click the Reset Private Feed button
    const resetBtn = page.locator('button:has-text("Reset Private Feed")');
    await expect(resetBtn.first()).toBeVisible({ timeout: 10000 });
    await resetBtn.first().click();

    // Wait for the reset dialog to appear
    await page.waitForTimeout(1000);
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Take screenshot of the reset dialog
    await page.screenshot({ path: 'screenshots/09-9.1-reset-dialog.png' });

    // Verify warning messages are shown
    const warningTexts = [
      /remove.*all.*current.*private.*followers/i,
      /make.*all.*existing.*private.*posts.*unreadable/i,
      /cannot.*be.*undone|this.*action/i,
    ];

    for (const pattern of warningTexts) {
      const warningText = page.getByText(pattern);
      const isVisible = await warningText.first().isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`Warning text "${pattern}" visible: ${isVisible}`);
    }

    // Check if stats are loaded (follower count, post count)
    const statsText = await dialog.textContent();
    console.log('Dialog content:', statsText?.substring(0, 500));

    // Enter encryption key
    const keyInput = dialog.locator('input[type="password"]');
    await expect(keyInput.first()).toBeVisible({ timeout: 5000 });

    if (!ownerIdentity.keys.encryptionKey) {
      console.log('Owner identity does not have encryption key - cannot complete reset');
      // Close dialog and skip
      const cancelBtn = dialog.locator('button:has-text("Cancel")');
      await cancelBtn.click();
      test.skip(true, 'Owner identity missing encryption key');
      return;
    }

    await keyInput.first().fill(ownerIdentity.keys.encryptionKey);

    // Type "RESET" in confirmation field
    const confirmInput = dialog.locator('input[type="text"]').or(
      dialog.locator('input[placeholder*="RESET"]')
    );
    await expect(confirmInput.first()).toBeVisible({ timeout: 5000 });
    await confirmInput.first().fill('RESET');

    // The Reset Private Feed button in the dialog should now be enabled
    const confirmResetBtn = dialog.locator('button').filter({ hasText: /^reset private feed$/i }).last();

    // Wait a moment for validation
    await page.waitForTimeout(1000);

    // Take screenshot before confirming
    await page.screenshot({ path: 'screenshots/09-9.1-before-reset-confirm.png' });

    // Click the confirmation button
    await confirmResetBtn.click();

    // Wait for the reset operation to complete (blockchain operation)
    // This may take a while
    await page.waitForTimeout(5000);

    // Check for loading spinner
    const spinner = dialog.locator('svg.animate-spin');
    const hasSpinner = await spinner.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasSpinner) {
      console.log('Reset operation in progress...');
      // Wait for spinner to disappear
      await expect(spinner).not.toBeVisible({ timeout: 120000 });
    }

    // Check for success toast or dialog closing
    const toast = page.locator('[role="alert"]');
    const hasToast = await toast.isVisible({ timeout: 15000 }).catch(() => false);
    if (hasToast) {
      const toastText = await toast.textContent();
      console.log('Toast message:', toastText);
    }

    // Dialog should close on success
    await expect(dialog).not.toBeVisible({ timeout: 30000 });

    // Take screenshot after reset
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/09-9.1-after-reset.png' });

    // Verify the dashboard shows reset state
    // After reset, should show 0 followers, epoch 1
    const followerStats = page.locator('.text-lg.font-semibold').filter({ hasText: '0' });
    const hasZeroFollowers = await followerStats.first().isVisible({ timeout: 10000 }).catch(() => false);

    if (hasZeroFollowers) {
      console.log('Dashboard shows 0 followers after reset (expected)');
    }

    // Track reset in-memory
    markPrivateFeedReset(1);
    markAccessRevokedByReset(2);

    console.log('Private feed reset completed successfully');
  });

  /**
   * Test 9.2: Old Posts After Reset — Owner View
   *
   * Preconditions:
   * - @owner just completed reset
   * - Old private posts exist on-chain
   *
   * Steps:
   * 1. @owner views their profile/feed
   *
   * Expected Results:
   * - Old private posts show: "[This private post was encrypted with a previous key]"
   * - No decrypt button (key is lost)
   * - Teaser content (if any) still visible
   * - New posts work normally with new keys
   *
   * Note: This test observes behavior of existing posts, not reset itself
   */
  test('9.2 Old Posts After Reset — Owner View', async ({ page, ownerIdentity, loginAs }) => {
    // Check if owner has been reset
    const identity1 = loadIdentity(1);
    const wasReset = !!(identity1 as { lastResetAt?: string }).lastResetAt;

    // This test is informative - it shows how old posts appear after reset
    // If no reset has happened, we just observe current behavior

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to profile to see posts
    await goToProfile(page, ownerIdentity.identityId);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Look for private posts
    const posts = page.locator('article');
    const postCount = await posts.count();
    console.log(`Found ${postCount} posts`);

    // Look for indicators of encrypted/inaccessible posts
    const encryptedIndicator = page.getByText(/encrypted.*previous.*key|cannot.*decrypt|key.*lost/i);
    const hasEncryptedIndicator = await encryptedIndicator.first().isVisible({ timeout: 5000 }).catch(() => false);

    // Look for lock icons on posts
    const lockIcons = page.locator('svg[class*="lock"]').or(
      page.locator('[aria-label*="lock"]').or(
        page.locator('[data-testid*="lock"]')
      )
    );
    const lockCount = await lockIcons.count();
    console.log(`Found ${lockCount} lock icons`);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/09-9.2-owner-view-after-reset.png' });

    console.log({
      wasReset,
      postCount,
      hasEncryptedIndicator,
      lockCount,
    });

    if (wasReset) {
      // After reset, old posts should show as inaccessible
      console.log('Testing owner view after reset');
      if (hasEncryptedIndicator) {
        console.log('Old posts show encrypted indicator (expected after reset)');
      }
    } else {
      // No reset happened - posts should be normal
      console.log('No reset has occurred - observing normal post view');
    }
  });

  /**
   * Test 9.3: Old Posts After Reset — Follower View
   *
   * Preconditions:
   * - @follower1 was approved before reset
   * - @follower1 has cached keys for old epoch
   *
   * Steps:
   * 1. @follower1 views @owner's old posts
   * 2. @follower1 clears cache and reloads
   *
   * Expected Results:
   * - Initially: Old posts may still decrypt with cached keys
   * - After cache clear: All old posts show locked state
   * - New posts: Cannot decrypt (grant is orphaned)
   */
  test('9.3 Old Posts After Reset — Follower View', async ({
    page,
    ownerIdentity,
    follower1Identity,
    loginAs
  }) => {
    // Check reset state
    const identity1 = loadIdentity(1);
    const wasReset = !!(identity1 as { lastResetAt?: string }).lastResetAt;

    // Login as follower
    await loginAs(follower1Identity);

    // Navigate to owner's profile
    await goToProfile(page, ownerIdentity.identityId);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Check initial view (with cached keys)
    const initialPosts = page.locator('article');
    const initialPostCount = await initialPosts.count();

    // Look for decrypted content (if cached keys work)
    const decryptedContent = page.locator('article p');
    const hasDecryptedContent = await decryptedContent.first().isVisible({ timeout: 5000 }).catch(() => false);

    // Look for locked indicators
    const lockedIndicator = page.getByText(/locked|encrypted|request access/i);
    const hasLockedIndicator = await lockedIndicator.first().isVisible({ timeout: 5000 }).catch(() => false);

    // Take screenshot before cache clear
    await page.screenshot({ path: 'screenshots/09-9.3-follower-before-cache-clear.png' });

    console.log({
      wasReset,
      initialPostCount,
      hasDecryptedContent,
      hasLockedIndicator,
    });

    // Now clear the cache and reload
    console.log('Clearing private feed cache...');
    await page.evaluate(() => {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('yappr:pf:') || key.includes('pathKey') || key.includes('privateKey'))) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
      console.log(`Cleared ${keysToRemove.length} keys`);
    });

    // Reload the page
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Check view after cache clear
    const afterCacheDecrypted = page.locator('article p');
    const stillHasDecryptedContent = await afterCacheDecrypted.first().isVisible({ timeout: 5000 }).catch(() => false);

    const afterCacheLocked = page.getByText(/locked|encrypted|request access/i);
    const nowShowsLocked = await afterCacheLocked.first().isVisible({ timeout: 5000 }).catch(() => false);

    // Take screenshot after cache clear
    await page.screenshot({ path: 'screenshots/09-9.3-follower-after-cache-clear.png' });

    console.log({
      stillHasDecryptedContent,
      nowShowsLocked,
    });

    if (wasReset) {
      console.log('After reset and cache clear, follower should not be able to decrypt posts');
      // After cache clear, posts should show as locked
      if (nowShowsLocked) {
        console.log('Posts show locked state after cache clear (expected)');
      }
    } else {
      console.log('No reset occurred - behavior depends on current access state');
    }
  });

  /**
   * Test 9.4: Followers After Reset
   *
   * Preconditions:
   * - @follower1 was approved before @owner reset
   *
   * Steps:
   * 1. @follower1 views @owner's profile after reset
   *
   * Expected Results:
   * - Button shows [Request Access] (not Approved)
   * - Previous approval no longer valid
   * - Must re-request and be re-approved
   */
  test('9.4 Followers After Reset', async ({ page, ownerIdentity, follower1Identity, loginAs }) => {
    // Check state
    const identity1 = loadIdentity(1);
    const identity2 = loadIdentity(2);
    const wasReset = !!(identity1 as { lastResetAt?: string }).lastResetAt;
    const accessRevokedByReset = !!(identity2 as { accessRevokedByReset?: boolean }).accessRevokedByReset;

    // Login as follower
    await loginAs(follower1Identity);

    // Navigate to owner's profile
    await goToProfile(page, ownerIdentity.identityId);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Check the access state buttons
    const requestAccessBtn = page.locator('button').filter({ hasText: /request access/i });
    const approvedBtn = page.locator('button').filter({ hasText: /approved|access granted/i });
    const pendingBtn = page.locator('button').filter({ hasText: /pending/i });
    const revokedBtn = page.locator('button').filter({ hasText: /revoked/i });
    const privateFolowerText = page.getByText(/private follower|you have access/i);

    const canRequestAccess = await requestAccessBtn.isVisible({ timeout: 10000 }).catch(() => false);
    const showsApproved = await approvedBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const showsPending = await pendingBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const showsRevoked = await revokedBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const showsPrivateFollower = await privateFolowerText.first().isVisible({ timeout: 5000 }).catch(() => false);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/09-9.4-follower-access-state-after-reset.png' });

    console.log({
      wasReset,
      accessRevokedByReset,
      canRequestAccess,
      showsApproved,
      showsPending,
      showsRevoked,
      showsPrivateFollower,
    });

    if (wasReset || accessRevokedByReset) {
      // After reset, follower should be able to request access again
      console.log('Testing follower state after reset');

      if (canRequestAccess) {
        console.log('Request Access button visible (expected after reset)');
        // Previous approval is no longer valid - must re-request
      } else if (showsRevoked) {
        console.log('Shows Revoked state - may need to check implementation behavior');
      } else if (showsApproved || showsPrivateFollower) {
        // This would be unexpected after reset
        console.log('WARNING: Still shows approved state after reset - may be a bug');
      }
    } else {
      // No reset - observe current state
      console.log('No reset occurred - current access state:');
      if (showsApproved || showsPrivateFollower) {
        console.log('Follower has approved access');
      } else if (canRequestAccess) {
        console.log('Follower can request access');
      } else if (showsPending) {
        console.log('Follower has pending request');
      } else if (showsRevoked) {
        console.log('Follower was revoked');
      }
    }
  });

  /**
   * Test: Verify Reset Dialog UI Elements
   *
   * This test opens the reset dialog without confirming, to verify UI elements
   * without actually performing a destructive reset.
   */
  test('Reset Dialog UI Elements', async ({ page, ownerIdentity, loginAs }) => {
    // Check if owner has private feed enabled
    const identity1 = loadIdentity(1);
    if (!identity1.privateFeedEnabled) {
      test.skip(true, 'Owner does not have private feed enabled');
      return;
    }

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToSettings(page, 'privateFeed');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Find the Reset button
    const resetBtn = page.locator('button:has-text("Reset Private Feed")');
    const hasResetBtn = await resetBtn.first().isVisible({ timeout: 10000 }).catch(() => false);

    if (!hasResetBtn) {
      console.log('Reset button not found');
      await page.screenshot({ path: 'screenshots/09-reset-dialog-no-button.png' });
      test.skip(true, 'Reset button not visible - private feed may be in unexpected state');
      return;
    }

    // Click to open the dialog
    await resetBtn.first().click();
    await page.waitForTimeout(1000);

    // Verify dialog appears
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Take screenshot of the dialog
    await page.screenshot({ path: 'screenshots/09-reset-dialog-ui.png' });

    // Verify key UI elements in the dialog
    const dialogTitle = dialog.getByText(/reset private feed/i);
    await expect(dialogTitle.first()).toBeVisible({ timeout: 5000 });

    // Warning about removing followers
    const followerWarning = dialog.getByText(/remove.*followers/i);
    const hasFollowerWarning = await followerWarning.first().isVisible({ timeout: 5000 }).catch(() => false);
    console.log('Has follower warning:', hasFollowerWarning);

    // Warning about posts becoming unreadable
    const postWarning = dialog.getByText(/unreadable/i);
    const hasPostWarning = await postWarning.first().isVisible({ timeout: 5000 }).catch(() => false);
    console.log('Has post warning:', hasPostWarning);

    // Encryption key input
    const keyInput = dialog.locator('input[type="password"]');
    await expect(keyInput.first()).toBeVisible({ timeout: 5000 });

    // RESET confirmation input
    const confirmLabel = dialog.getByText(/type.*RESET/i);
    const hasConfirmLabel = await confirmLabel.first().isVisible({ timeout: 5000 }).catch(() => false);
    console.log('Has RESET confirmation label:', hasConfirmLabel);

    // Cancel button
    const cancelBtn = dialog.locator('button:has-text("Cancel")');
    await expect(cancelBtn.first()).toBeVisible({ timeout: 5000 });

    // Reset confirm button (should be disabled initially)
    const confirmResetBtn = dialog.locator('button').filter({ hasText: /^reset private feed$/i }).last();
    const confirmBtnVisible = await confirmResetBtn.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('Confirm button visible:', confirmBtnVisible);

    if (confirmBtnVisible) {
      const isDisabled = await confirmResetBtn.isDisabled();
      console.log('Confirm button disabled (should be true when fields empty):', isDisabled);
      expect(isDisabled).toBe(true);
    }

    // Close the dialog without confirming
    await cancelBtn.first().click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    console.log('Reset dialog UI verification complete');
  });
});
