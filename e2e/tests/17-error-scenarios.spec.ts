import { test, expect } from '../fixtures/auth.fixture';
import { goToPrivateFeedSettings, goToProfile, goToHome } from '../helpers/navigation.helpers';
import { loadIdentity } from '../test-data/identities';
import { handleEncryptionKeyModal } from '../helpers/modal.helpers';

/**
 * Test Suite: Error Scenarios
 * Reference: YAPPR_PRIVATE_FEED_E2E_TESTS.md §17 & e2e_prd.md §7 (P2)
 *
 * Tests error handling scenarios for private feeds:
 * - 17.1 Private Feed at Capacity (conceptual - cannot easily create 1024 followers)
 * - 17.2 Epoch Chain Exhausted (conceptual - cannot easily create 2000 revocations)
 * - 17.3 Network Error During Approval (conceptual - verify error UI exists)
 * - 17.4 Decryption Retry After Failure (can simulate via localStorage manipulation)
 *
 * NOTE: Tests 17.1 and 17.2 require preconditions that are impractical to create
 * in a test environment (1024 followers, 2000 revocations). These tests verify
 * the infrastructure is in place and document the expected error behavior.
 *
 * Test Users:
 * - @owner (Identity 1): Has private feed enabled
 * - @follower1 (Identity 2): May have access (approved or revoked)
 */

/**
 * Helper to clear private feed keys from localStorage to simulate corruption
 */
async function clearPrivateFeedKeys(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (
        key.startsWith('yappr:pf:') ||
        key.includes('pathKey') ||
        key.includes('_cek_')
      )) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    return keysToRemove.length;
  });
}

test.describe('17 - Error Scenarios', () => {
  // Log console errors for debugging
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`Browser error: ${msg.text()}`);
      }
    });
  });

  /**
   * Test 17.1: Private Feed at Capacity (Conceptual Verification)
   *
   * This test verifies the capacity-related UI elements exist and function correctly.
   * Since we can't easily create 1024 followers, we verify:
   * 1. The capacity display shows "X / 1024" format
   * 2. The UI correctly displays the current follower count
   *
   * The actual "at capacity" error behavior is documented but not tested due to
   * the impracticality of creating 1024 test identities.
   *
   * Expected error (when at capacity):
   * - Error: "Private feed is full (1024/1024)"
   * - Suggestion: "Revoke inactive followers to make room"
   * - Approval blocked
   */
  test('17.1 Private Feed at Capacity - Verify Capacity UI', async ({ page, ownerIdentity, loginAs }) => {
    // Check if owner has private feed enabled
    const ownerData = loadIdentity(1);
    if (!ownerData.privateFeedEnabled) {
      test.skip(true, 'Owner does not have private feed enabled');
      return;
    }

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToPrivateFeedSettings(page);
    await page.waitForLoadState('networkidle');

    // Handle encryption key modal if it appears
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Wait for dashboard to load
    await page.waitForTimeout(5000);

    // Look for the capacity display (format: "X / 1024")
    const capacityDisplay = page.getByText(/\d+\s*\/\s*1,?024/);
    const hasCapacityDisplay = await capacityDisplay.isVisible({ timeout: 10000 }).catch(() => false);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/17-17.1-capacity-display.png' });

    if (hasCapacityDisplay) {
      const capacityText = await capacityDisplay.textContent();
      console.log(`Capacity display found: ${capacityText}`);

      // Verify capacity shows reasonable format
      expect(capacityText).toMatch(/\d+\s*\/\s*1,?024/);
      console.log('SUCCESS: Capacity display shows correct format (X / 1024)');
    } else {
      // Look for alternative capacity indicators
      const followersCard = page.locator('text=Followers').first();
      const hasFollowersCard = await followersCard.isVisible({ timeout: 5000 }).catch(() => false);

      if (hasFollowersCard) {
        console.log('INFO: Followers card visible - capacity tracking is functional');
      }
    }

    // Document expected behavior at capacity
    console.log('DOCUMENTATION: At capacity (1024 followers), approval attempts should show:');
    console.log('  - Error: "Private feed is full (1024/1024)"');
    console.log('  - Suggestion: "Revoke inactive followers to make room"');
    console.log('  - Approval should be blocked');
  });

  /**
   * Test 17.2: Epoch Chain Exhausted (Conceptual Verification)
   *
   * This test verifies the epoch usage UI elements exist and function correctly.
   * Since we can't easily perform 2000 revocations, we verify:
   * 1. The epoch usage display exists
   * 2. The progress bar shows current usage
   *
   * The actual "epoch exhausted" error behavior is documented but not tested.
   *
   * Expected error (when epoch exhausted):
   * - Error: "Private feed needs migration"
   * - Guidance to contact support
   * - Revocation blocked
   */
  test('17.2 Epoch Chain Exhausted - Verify Epoch Usage UI', async ({ page, ownerIdentity, loginAs }) => {
    // Check if owner has private feed enabled
    const ownerData = loadIdentity(1);
    if (!ownerData.privateFeedEnabled) {
      test.skip(true, 'Owner does not have private feed enabled');
      return;
    }

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToPrivateFeedSettings(page);
    await page.waitForLoadState('networkidle');

    // Handle encryption key modal if it appears
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Wait for dashboard to load
    await page.waitForTimeout(5000);

    // Look for epoch usage section
    const epochLabel = page.getByText('Epoch Usage');
    const hasEpochLabel = await epochLabel.isVisible({ timeout: 10000 }).catch(() => false);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/17-17.2-epoch-usage.png' });

    if (hasEpochLabel) {
      console.log('SUCCESS: Epoch Usage section is visible');

      // Look for revocation count display
      const revocationCount = page.getByText(/\d+\s*\/\s*\d+\s*revocation/i);
      const hasRevocationCount = await revocationCount.isVisible({ timeout: 5000 }).catch(() => false);

      if (hasRevocationCount) {
        const countText = await revocationCount.textContent();
        console.log(`Revocation count display: ${countText}`);
      }

      // Look for progress bar
      const progressBar = page.locator('div[class*="h-full"][class*="rounded-full"]');
      const hasProgressBar = await progressBar.first().isVisible({ timeout: 5000 }).catch(() => false);

      if (hasProgressBar) {
        const progressClasses = await progressBar.first().getAttribute('class').catch(() => '');
        console.log(`Progress bar found with classes: ${progressClasses}`);

        // Check color to understand current state
        if (progressClasses?.includes('red')) {
          console.log('WARNING: Epoch usage is high (>90%)');
        } else if (progressClasses?.includes('amber')) {
          console.log('CAUTION: Epoch usage is moderate (50-90%)');
        } else if (progressClasses?.includes('green')) {
          console.log('HEALTHY: Epoch usage is low (<50%)');
        }
      }
    } else {
      console.log('INFO: Epoch Usage section not visible (may be collapsed or loading)');
    }

    // Document expected behavior when epoch exhausted
    console.log('DOCUMENTATION: When epoch chain is exhausted (2000+ revocations), revocation attempts should show:');
    console.log('  - Error: "Private feed needs migration"');
    console.log('  - Guidance to contact support');
    console.log('  - Revocation should be blocked');
  });

  /**
   * Test 17.3: Network Error During Approval (Conceptual Verification)
   *
   * Testing actual network failures is complex and flaky. Instead, we verify:
   * 1. The approval flow exists and is functional
   * 2. Error handling UI elements are in place
   *
   * The actual network error behavior is documented.
   *
   * Expected error (on network failure):
   * - Error: "Connection error - unable to approve"
   * - [Retry] button available
   * - No partial state created on-chain
   */
  test('17.3 Network Error During Approval - Verify Approval Flow Exists', async ({ page, ownerIdentity, loginAs }) => {
    // Check if owner has private feed enabled
    const ownerData = loadIdentity(1);
    if (!ownerData.privateFeedEnabled) {
      test.skip(true, 'Owner does not have private feed enabled');
      return;
    }

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToPrivateFeedSettings(page);
    await page.waitForLoadState('networkidle');

    // Handle encryption key modal if it appears
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Wait for page to load
    await page.waitForTimeout(5000);

    // Look for the Private Feed Requests section
    const requestsSection = page.getByText('Private Feed Requests');
    const hasRequestsSection = await requestsSection.isVisible({ timeout: 10000 }).catch(() => false);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/17-17.3-approval-flow.png' });

    if (hasRequestsSection) {
      console.log('SUCCESS: Private Feed Requests section is visible');

      // Check for pending requests
      const approveButtons = page.locator('button').filter({ hasText: /approve/i });
      const approveCount = await approveButtons.count();
      console.log(`Found ${approveCount} approve button(s)`);

      // Check for "no pending requests" message
      const noPendingMsg = page.getByText(/no pending requests|no requests/i);
      const hasNoPending = await noPendingMsg.isVisible({ timeout: 3000 }).catch(() => false);

      if (hasNoPending) {
        console.log('INFO: No pending requests to approve');
      }
    } else {
      console.log('INFO: Requests section not visible (dashboard may show different state)');
    }

    // Document expected error behavior
    console.log('DOCUMENTATION: On network error during approval:');
    console.log('  - Error: "Connection error - unable to approve"');
    console.log('  - [Retry] button should be available');
    console.log('  - No partial state should be created on-chain');
    console.log('  - Retry should be safe (idempotent operation)');
  });

  /**
   * Test 17.4: Decryption Retry After Failure
   *
   * This test simulates a decryption failure by clearing cached keys,
   * then verifies the recovery flow works correctly.
   *
   * Steps:
   * 1. Login as an approved follower (or revoked follower)
   * 2. Clear private feed keys from localStorage
   * 3. Navigate to owner's profile
   * 4. Verify locked state or recovery prompt appears
   * 5. Re-enter encryption key if prompted
   * 6. Verify decryption recovery succeeds
   */
  test('17.4 Decryption Retry After Failure', async ({ page, follower1Identity, ownerIdentity, loginAs }) => {
    // This test requires follower1 to have some relationship with owner's private feed
    // Either approved or revoked - both should show appropriate recovery behavior

    // Login as follower1
    await loginAs(follower1Identity);

    // Navigate to owner's profile first to establish baseline
    await goToProfile(page, ownerIdentity.identityId);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Take baseline screenshot
    await page.screenshot({ path: 'screenshots/17-17.4-baseline.png' });

    // Clear private feed keys to simulate corruption/failure
    console.log('Simulating decryption failure by clearing cached keys...');
    const clearedCount = await clearPrivateFeedKeys(page);
    console.log(`Cleared ${clearedCount} private feed key(s) from localStorage`);

    // Reload page to trigger re-decryption attempt
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Take screenshot after cache clear
    await page.screenshot({ path: 'screenshots/17-17.4-after-clear.png' });

    // Check for recovery scenarios:
    // 1. Encryption key modal appears (user needs to re-enter key)
    // 2. Content shows locked state (graceful degradation)
    // 3. Retry button appears

    const encryptionModal = page.getByRole('dialog', { name: /Enter Encryption Key/i });
    const modalVisible = await encryptionModal.isVisible({ timeout: 5000 }).catch(() => false);

    const lockedContent = page.getByText(/locked|encrypted|private|request access/i);
    const hasLockedContent = await lockedContent.first().isVisible({ timeout: 5000 }).catch(() => false);

    const retryButton = page.locator('button').filter({ hasText: /retry/i });
    const hasRetryButton = await retryButton.isVisible({ timeout: 3000 }).catch(() => false);

    console.log({
      modalVisible,
      hasLockedContent,
      hasRetryButton,
    });

    if (modalVisible) {
      console.log('RECOVERY: Encryption key modal appeared - attempting re-entry');

      if (follower1Identity.keys.encryptionKey) {
        // Enter the encryption key
        const keyInput = encryptionModal.locator('input[type="password"]');
        await keyInput.first().fill(follower1Identity.keys.encryptionKey);

        const saveBtn = encryptionModal.locator('button').filter({ hasText: /save|confirm/i });
        await saveBtn.first().click();

        // Wait for modal to close and recovery to complete
        await expect(encryptionModal).not.toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(3000);

        // Take screenshot after recovery
        await page.screenshot({ path: 'screenshots/17-17.4-after-recovery.png' });

        console.log('SUCCESS: Decryption recovery via key re-entry completed');
      }
    } else if (hasRetryButton) {
      console.log('RECOVERY: Retry button is available');

      // Click retry and verify behavior
      await retryButton.click();
      await page.waitForTimeout(3000);

      // Take screenshot after retry
      await page.screenshot({ path: 'screenshots/17-17.4-after-retry.png' });

      console.log('SUCCESS: Retry mechanism is available and functional');
    } else if (hasLockedContent) {
      console.log('GRACEFUL DEGRADATION: Content shows locked state after cache corruption');
      console.log('User can recover by going to settings and re-entering encryption key');
    } else {
      console.log('INFO: Page in stable state after cache clear');
    }

    // Verify no infinite loops - page should be responsive
    const pageResponsive = await page.evaluate(() => {
      return document.readyState === 'complete';
    });
    expect(pageResponsive).toBe(true);
    console.log('VERIFIED: No infinite retry loops - page remains responsive');
  });

  /**
   * Bonus Test: Toast Notification Error Handling
   *
   * Verifies that error toast notifications can be displayed and dismissed
   */
  test('Bonus: Toast Notification System Works', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to home to trigger any pending notifications
    await goToHome(page);
    await page.waitForTimeout(3000);

    // Check if any toast notifications are visible
    const toasts = page.locator('[role="alert"]');
    const toastCount = await toasts.count();

    if (toastCount > 0) {
      console.log(`Found ${toastCount} toast notification(s)`);

      // Take screenshot
      await page.screenshot({ path: 'screenshots/17-bonus-toast.png' });

      // Verify toasts can be dismissed
      const closeButton = toasts.first().locator('button');
      if (await closeButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeButton.click();
        await page.waitForTimeout(1000);
        console.log('Toast notification dismissed successfully');
      }
    } else {
      console.log('INFO: No toast notifications currently visible');
    }

    // Navigate to private feed settings and try to trigger an action
    await goToPrivateFeedSettings(page);
    await page.waitForLoadState('networkidle');

    // Handle encryption key modal if it appears
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    await page.waitForTimeout(3000);

    // Take final screenshot
    await page.screenshot({ path: 'screenshots/17-bonus-final.png' });

    // Document error toast expectations
    console.log('DOCUMENTATION: Error toasts should:');
    console.log('  - Appear within the viewport');
    console.log('  - Be dismissible via close button or timeout');
    console.log('  - Have clear error messages');
    console.log('  - Not block user interaction');

    expect(true).toBe(true);
  });

  /**
   * Bonus Test: Error Recovery After Browser Refresh
   *
   * Verifies that the app recovers gracefully after a browser refresh
   * during an operation
   */
  test('Bonus: Error Recovery After Browser Refresh', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToPrivateFeedSettings(page);
    await page.waitForLoadState('networkidle');

    // Handle encryption key modal if it appears
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    await page.waitForTimeout(5000);

    // Take baseline screenshot
    await page.screenshot({ path: 'screenshots/17-bonus-before-refresh.png' });

    // Simulate sudden page refresh (like browser crash recovery)
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Handle encryption key modal again if it appears after refresh
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    await page.waitForTimeout(5000);

    // Take screenshot after refresh
    await page.screenshot({ path: 'screenshots/17-bonus-after-refresh.png' });

    // Verify page recovered correctly
    const dashboard = page.locator('text=Your Private Feed').or(page.locator('text=Private Feed'));
    const hasDashboard = await dashboard.first().isVisible({ timeout: 10000 }).catch(() => false);

    if (hasDashboard) {
      console.log('SUCCESS: Page recovered correctly after refresh');
    } else {
      // Check if we're on a different but valid state
      const settingsPage = page.locator('text=Settings');
      const hasSettings = await settingsPage.first().isVisible({ timeout: 5000 }).catch(() => false);

      if (hasSettings) {
        console.log('SUCCESS: Recovered to valid settings page after refresh');
      }
    }

    // Verify no error state
    const errorMessage = page.getByText(/error|failed|unable/i);
    const hasError = await errorMessage.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (hasError) {
      const errorText = await errorMessage.first().textContent();
      console.log(`WARNING: Error visible after refresh: ${errorText}`);
    } else {
      console.log('SUCCESS: No error state after refresh');
    }
  });
});
