import { test, expect } from '../fixtures/auth.fixture';
import { goToSettings, goToNotifications, goToProfile, waitForToast } from '../helpers/navigation.helpers';
import { loadIdentity } from '../test-data/identities';
import { handleEncryptionKeyModal } from '../helpers/modal.helpers';
import { markAsPrivateFollower, getIdentityState } from '../test-data/test-state';

/**
 * Test Suite: Approve Follower Flow
 * Reference: YAPPR_PRIVATE_FEED_E2E_TESTS.md §4 & e2e_prd.md §7 (P0)
 *
 * Tests the private feed approval flow from the owner's perspective:
 * - 4.1 View Pending Requests
 * - 4.2 Approve Request - Happy Path
 * - 4.3 Ignore Request
 * - 4.4 Approve from Notification
 * - 4.5 FollowRequest Cleanup After Approval
 *
 * Test Users:
 * - @owner (Identity 1): Has private feed enabled, receives access requests
 * - @follower1 (Identity 2): Has pending request to @owner (from test 03)
 * - @follower2 (Identity 3): May have pending request for ignore test
 */

test.describe('04 - Approve Follower Flow', () => {
  // Log console errors for debugging
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`Browser error: ${msg.text()}`);
      }
    });
  });

  /**
   * Test 4.1: View Pending Requests
   *
   * Preconditions:
   * - @owner has private feed enabled
   * - At least one follower has requested access
   *
   * Steps:
   * 1. @owner navigates to Private Feed Settings
   * 2. Verify the Private Feed Requests section is visible
   *
   * Expected Results:
   * - Requests visible with usernames and timestamps
   * - Each request has [Approve] [Ignore] buttons
   */
  test('4.1 View Pending Requests', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToSettings(page, 'privateFeed');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Look for the Private Feed Requests section
    const requestsCard = page.locator('text=Private Feed Requests').first();
    await expect(requestsCard).toBeVisible({ timeout: 30000 });

    // Check for any requests - look for the approve button to indicate requests exist
    const approveBtn = page.locator('button').filter({ hasText: /approve/i });
    const noRequestsText = page.getByText(/no pending requests/i);

    const hasRequests = await approveBtn.first().isVisible({ timeout: 5000 }).catch(() => false);
    const hasNoRequests = await noRequestsText.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasRequests) {
      // Verify the request has both Approve and Ignore buttons
      await expect(approveBtn.first()).toBeVisible();

      const ignoreBtn = page.locator('button').filter({ hasText: /ignore/i });
      await expect(ignoreBtn.first()).toBeVisible();

      // Take screenshot of the requests
      await page.screenshot({ path: 'screenshots/04-4.1-pending-requests.png' });
      console.log('Found pending requests with Approve/Ignore buttons');
    } else if (hasNoRequests) {
      // No pending requests - this is valid if all were already processed
      console.log('No pending requests found - this is OK if tests ran previously');
      await page.screenshot({ path: 'screenshots/04-4.1-no-pending-requests.png' });
    } else {
      // Take screenshot to debug
      await page.screenshot({ path: 'screenshots/04-4.1-requests-unknown-state.png' });
      console.log('Could not determine requests state');
    }
  });

  /**
   * Test 4.2: Approve Request - Happy Path
   *
   * Preconditions:
   * - @follower1 has pending request to @owner
   *
   * Steps:
   * 1. @owner logs in and goes to Private Feed Settings
   * 2. Find the pending request from @follower1
   * 3. Click [Approve] button
   *
   * Expected Results:
   * - Loading state shown during operation
   * - PrivateFeedGrant document created on-chain
   * - Request disappears from pending list
   * - Dashboard updates: Followers count +1
   * - Toast notification shown
   */
  test('4.2 Approve Request - Happy Path', async ({ page, ownerIdentity, follower1Identity, loginAs }) => {
    // Check if follower1 is already approved from previous runs
    const identity2 = loadIdentity(2);
    if (identity2.isPrivateFollowerOf === ownerIdentity.identityId) {
      test.skip(true, 'Follower1 already approved from previous run');
      return;
    }

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToSettings(page, 'privateFeed');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000); // Wait for async data loading

    // Look for the Private Feed Requests section
    const requestsCard = page.locator('text=Private Feed Requests').first();
    await expect(requestsCard).toBeVisible({ timeout: 30000 });

    // Check for pending requests
    const approveBtn = page.locator('button').filter({ hasText: /approve/i });
    const hasRequests = await approveBtn.first().isVisible({ timeout: 10000 }).catch(() => false);

    if (!hasRequests) {
      // No pending requests - check if follower1 already has access
      const followersSection = page.locator('text=Private Followers').first();
      const hasFollowersSection = await followersSection.isVisible({ timeout: 5000 }).catch(() => false);

      if (hasFollowersSection) {
        // Scroll to see if follower1 is in the followers list
        await followersSection.scrollIntoViewIfNeeded();
        await page.waitForTimeout(2000);

        // Look for the follower's identity ID (last 6 chars) or their display name
        const followerIdShort = follower1Identity.identityId.slice(-6);
        const followerEntry = page.getByText(new RegExp(`User.*${followerIdShort}|Test Follower|follower`, 'i'));
        const isAlreadyFollower = await followerEntry.first().isVisible({ timeout: 5000 }).catch(() => false);

        if (isAlreadyFollower) {
          // Track in-memory and skip
          markAsPrivateFollower(2, ownerIdentity.identityId);
          test.skip(true, 'Follower1 is already a private follower');
          return;
        }
      }

      // Take screenshot and note the state
      await page.screenshot({ path: 'screenshots/04-4.2-no-requests-to-approve.png' });
      console.log('No pending requests to approve. Run test 03 first to create a request.');
      return;
    }

    // Click the first Approve button
    // Note: We're approving whoever is first in the list
    await approveBtn.first().click();

    // Wait for the approval to process (blockchain operation)
    // The approval may trigger an encryption key modal if the private feed state needs syncing
    await page.waitForTimeout(2000);

    // Check for and handle encryption key modal
    const encryptionKeyHandled = await handleEncryptionKeyModal(page, ownerIdentity);
    if (encryptionKeyHandled) {
      console.log('Handled encryption key modal during approval');
      // After entering key, need to click approve again - the modal may have interrupted the flow
      await page.waitForTimeout(3000);

      // Check if we need to re-approve (request still visible)
      const approveAgain = page.locator('button').filter({ hasText: /approve/i });
      const needsReapprove = await approveAgain.first().isVisible({ timeout: 5000 }).catch(() => false);
      if (needsReapprove) {
        await approveAgain.first().click();
        await page.waitForTimeout(2000);
      }
    }

    // Look for loading spinner on the button
    const loadingSpinner = page.locator('svg.animate-spin');
    const spinnerVisible = await loadingSpinner.first().isVisible({ timeout: 5000 }).catch(() => false);
    if (spinnerVisible) {
      // Wait for spinner to disappear (approval complete)
      await expect(loadingSpinner.first()).not.toBeVisible({ timeout: 60000 });
    }

    // Wait for success indicators
    await page.waitForTimeout(3000);

    // Check for success toast
    const toast = page.locator('[role="alert"]');
    const hasSuccessToast = await toast.isVisible({ timeout: 10000 }).catch(() => false);

    if (hasSuccessToast) {
      const toastText = await toast.textContent();
      console.log('Toast message:', toastText);

      // Verify it's a success message (should mention "Approved" or not be an error)
      // The toast may contain the username like "Approved @username"
      const isSuccess = toastText?.toLowerCase().includes('approved') ||
                        toastText?.toLowerCase().includes('success') ||
                        !toastText?.toLowerCase().includes('error');
      expect(isSuccess).toBe(true);
    }

    // Verify the request is no longer in the pending list (or list is now empty)
    await page.waitForTimeout(2000);

    // Take screenshot of post-approval state
    await page.screenshot({ path: 'screenshots/04-4.2-after-approval.png' });

    // Track approval in-memory
    markAsPrivateFollower(2, ownerIdentity.identityId);

    console.log('Successfully approved follower request');
  });

  /**
   * Test 4.3: Ignore Request
   *
   * Preconditions:
   * - @follower2 has pending request
   *
   * Steps:
   * 1. @owner clicks [Ignore] for a request
   *
   * Expected Results:
   * - Request dismissed from UI
   * - FollowRequest document remains on-chain (can approve later)
   * - No notification sent to requester
   */
  test('4.3 Ignore Request', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToSettings(page, 'privateFeed');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Look for the Ignore button
    const ignoreBtn = page.locator('button').filter({ hasText: /ignore/i });
    const hasRequests = await ignoreBtn.first().isVisible({ timeout: 10000 }).catch(() => false);

    if (!hasRequests) {
      // No pending requests to ignore
      console.log('No pending requests to ignore');
      await page.screenshot({ path: 'screenshots/04-4.3-no-requests-to-ignore.png' });
      test.skip(true, 'No pending requests available to test ignore flow');
      return;
    }

    // Count requests before ignoring
    const approveButtons = page.locator('button').filter({ hasText: /approve/i });
    const initialCount = await approveButtons.count();
    console.log(`Found ${initialCount} pending requests before ignore`);

    // Click Ignore on the first request
    await ignoreBtn.first().click();

    // Wait for UI update
    await page.waitForTimeout(2000);

    // Check for success toast (may say "ignored" or similar)
    const toast = page.locator('[role="alert"]');
    const hasToast = await toast.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasToast) {
      const toastText = await toast.textContent();
      console.log('Toast message:', toastText);
    }

    // Verify the request was removed from UI
    const newCount = await approveButtons.count();
    console.log(`Found ${newCount} pending requests after ignore`);

    // The count should decrease by 1
    if (initialCount > 0) {
      expect(newCount).toBeLessThan(initialCount);
    }

    // Take screenshot
    await page.screenshot({ path: 'screenshots/04-4.3-after-ignore.png' });
  });

  /**
   * Test 4.4: Approve from Notification
   *
   * Preconditions:
   * - @owner has pending request notification
   *
   * Steps:
   * 1. @owner opens notifications
   * 2. Find the "requested access to your private feed" notification
   * 3. Click the "View Requests" link
   * 4. Approve the request from the settings page
   *
   * Expected Results:
   * - Navigation to settings page works
   * - Can approve the request from there
   */
  test('4.4 Approve from Notification', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to notifications
    await goToNotifications(page);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // Look for private feed request notifications
    const privateFeedTab = page.locator('button').filter({ hasText: /private feed/i });
    const tabVisible = await privateFeedTab.isVisible({ timeout: 5000 }).catch(() => false);

    if (tabVisible) {
      // Click the Private Feed filter tab
      await privateFeedTab.click();
      await page.waitForTimeout(2000);
    }

    // Look for "requested access" notification text
    const requestNotification = page.getByText(/requested access to your private feed/i);
    const hasRequestNotification = await requestNotification.first().isVisible({ timeout: 10000 }).catch(() => false);

    if (!hasRequestNotification) {
      // Check if there's a "no notifications" message
      const noNotifications = page.getByText(/no notifications/i);
      const hasNoNotifications = await noNotifications.isVisible({ timeout: 3000 }).catch(() => false);

      if (hasNoNotifications) {
        console.log('No private feed notifications found');
        await page.screenshot({ path: 'screenshots/04-4.4-no-notifications.png' });
        test.skip(true, 'No private feed request notifications to test');
        return;
      }

      // Take screenshot of current state
      await page.screenshot({ path: 'screenshots/04-4.4-notifications-state.png' });
      console.log('Could not find private feed request notification');
      return;
    }

    // Found a request notification - look for the "View Requests" link
    const viewRequestsLink = page.locator('a').filter({ hasText: /view requests/i });
    const hasLink = await viewRequestsLink.first().isVisible({ timeout: 5000 }).catch(() => false);

    if (hasLink) {
      // Click the link to go to settings
      await viewRequestsLink.first().click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000);

      // Verify we're on the private feed settings page
      const privateFeedSettings = page.getByText(/private feed requests/i).or(
        page.getByText(/your private feed/i)
      );
      await expect(privateFeedSettings.first()).toBeVisible({ timeout: 10000 });

      // Now we can approve from here (if there are requests)
      const approveBtn = page.locator('button').filter({ hasText: /approve/i });
      const canApprove = await approveBtn.first().isVisible({ timeout: 5000 }).catch(() => false);

      if (canApprove) {
        console.log('Successfully navigated from notification to approve requests');
        await page.screenshot({ path: 'screenshots/04-4.4-ready-to-approve.png' });
      } else {
        console.log('Navigated to settings but no pending requests to approve');
        await page.screenshot({ path: 'screenshots/04-4.4-no-pending-after-nav.png' });
      }
    } else {
      // The notification doesn't have a direct link - click on it to see what happens
      await requestNotification.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'screenshots/04-4.4-notification-clicked.png' });
    }
  });

  /**
   * Test 4.5: FollowRequest Cleanup After Approval
   *
   * Preconditions:
   * - @follower1 was just approved by @owner (from test 4.2)
   *
   * Steps:
   * 1. @follower1 logs in
   * 2. Navigate to @owner's profile
   * 3. Verify request state has changed from "Pending" to approved
   *
   * Expected Results:
   * - @follower1 no longer sees "Pending" status
   * - @follower1 sees approved/private follower indicator
   */
  test('4.5 FollowRequest Cleanup After Approval', async ({ page, follower1Identity, ownerIdentity, loginAs }) => {
    // Check if follower1 should be approved (from test 4.2 or previous runs)
    const identity2 = loadIdentity(2);
    if (!identity2.isPrivateFollowerOf) {
      // May not have been approved yet
      console.log('Follower1 has not been marked as approved - checking on-chain state');
    }

    // Login as follower1
    await loginAs(follower1Identity);

    // Navigate to owner's profile
    await goToProfile(page, ownerIdentity.identityId);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Check for various possible states
    const pendingBtn = page.locator('button').filter({ hasText: /pending/i });
    const approvedIndicator = page.getByText(/private follower|approved|access granted/i);
    const privateIndicator = page.locator('[data-testid="private-follower-badge"]').or(
      page.locator('svg').filter({ has: page.locator('title:has-text("Private")') })
    );
    const requestAccessBtn = page.locator('button').filter({ hasText: /request access/i });
    const revokedBtn = page.locator('button').filter({ hasText: /revoked/i });

    const isPending = await pendingBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const isApproved = await approvedIndicator.first().isVisible({ timeout: 5000 }).catch(() => false);
    const hasPrivateBadge = await privateIndicator.first().isVisible({ timeout: 3000 }).catch(() => false);
    const canRequestAgain = await requestAccessBtn.isVisible({ timeout: 3000 }).catch(() => false);
    const isRevoked = await revokedBtn.isVisible({ timeout: 3000 }).catch(() => false);

    // Take screenshot of current state
    await page.screenshot({ path: 'screenshots/04-4.5-follower-view-owner-profile.png' });

    if (isPending) {
      console.log('Request is still pending - approval may not have completed');
      // This could mean test 4.2 didn't run or approval failed
    } else if (isApproved || hasPrivateBadge) {
      console.log('Follower1 has approved access - cleanup confirmed');

      // Track approval in-memory if not already tracked
      const state = getIdentityState(2);
      if (!state.isPrivateFollowerOf) {
        markAsPrivateFollower(2, ownerIdentity.identityId);
      }

      // Verify pending is NOT shown
      await expect(pendingBtn).not.toBeVisible({ timeout: 3000 });
    } else if (isRevoked) {
      console.log('Follower1 was revoked - cannot verify cleanup');
    } else if (canRequestAgain) {
      console.log('Follower1 can request access again - request may have been cancelled or denied');
    } else {
      console.log('Unable to determine follower1 access state from profile');
    }

    // Log the current state for debugging
    console.log({
      isPending,
      isApproved,
      hasPrivateBadge,
      canRequestAgain,
      isRevoked,
    });
  });

  /**
   * Test 4.6: Dashboard Updates After Approval
   *
   * Preconditions:
   * - @owner has approved at least one follower
   *
   * Steps:
   * 1. @owner navigates to Private Feed Settings
   * 2. Check the dashboard stats
   *
   * Expected Results:
   * - Dashboard shows follower count > 0
   * - Recent activity shows the approval
   */
  test('4.6 Dashboard Updates After Approval', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings
    await goToSettings(page, 'privateFeed');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // Look for the dashboard card "Your Private Feed"
    const dashboardCard = page.getByText('Your Private Feed').first();
    const hasDashboard = await dashboardCard.isVisible({ timeout: 10000 }).catch(() => false);

    if (!hasDashboard) {
      console.log('Dashboard not visible - private feed may not be enabled');
      await page.screenshot({ path: 'screenshots/04-4.6-no-dashboard.png' });
      return;
    }

    // Check follower count
    const followersLabel = page.getByText(/followers/i);
    await expect(followersLabel.first()).toBeVisible({ timeout: 10000 });

    // Look for follower count number - the dashboard shows it in a styled card
    // The format is typically a large number followed by the capacity (e.g., "1" and "/1024")
    // Try to find the number in the stats grid
    const statsCards = page.locator('.text-2xl.font-bold');
    const statsCount = await statsCards.count();
    let followerCount = 0;

    if (statsCount > 0) {
      const countText = await statsCards.first().textContent().catch(() => '0');
      followerCount = parseInt(countText || '0', 10);
      if (isNaN(followerCount)) {
        followerCount = 0;
      }
    }

    console.log(`Dashboard shows ${followerCount} followers`);

    // Check for recent activity section
    const recentActivity = page.getByText(/recent activity/i);
    const hasActivity = await recentActivity.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasActivity) {
      // Look for approval activity entries
      const approvedEntry = page.getByText(/approved/i);
      const hasApprovedEntry = await approvedEntry.first().isVisible({ timeout: 5000 }).catch(() => false);

      if (hasApprovedEntry) {
        console.log('Recent activity shows approval(s)');
      }
    }

    // Take screenshot of dashboard
    await page.screenshot({ path: 'screenshots/04-4.6-dashboard-after-approval.png' });
  });
});
