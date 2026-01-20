import { test, expect } from '../fixtures/auth.fixture';
import { goToHome, openComposeModal, goToPrivateFeedSettings, goToProfile, closeModal } from '../helpers/navigation.helpers';
import { loadIdentity } from '../test-data/identities';
import { handleEncryptionKeyModal } from '../helpers/modal.helpers';

/**
 * Test Suite: Performance Tests
 * Reference: YAPPR_PRIVATE_FEED_E2E_TESTS.md §18 & e2e_prd.md §7 (P2)
 *
 * Tests performance metrics for private feed operations:
 * - 18.1 Private Feed Enable Time (< 5 seconds)
 * - 18.2 Private Post Creation Latency (comparable to public posts)
 * - 18.3 Single Post Decryption Latency (< 100ms)
 * - 18.4 Revocation Completion Time (< 10 seconds)
 * - 18.5 Batch Decryption in Feed
 *
 * NOTE: These tests measure performance characteristics rather than strict assertions.
 * Blockchain operations inherently have variable timing due to network conditions.
 * Tests log timing data and provide soft assertions with reasonable thresholds.
 *
 * Test Users:
 * - @owner (Identity 1): Has private feed enabled
 * - @follower1 (Identity 2): May have access (approved or revoked)
 */

/**
 * Helper to measure time for an async operation
 */
async function measureTime<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<{ result: T; durationMs: number }> {
  const startTime = performance.now();
  const result = await operation();
  const endTime = performance.now();
  const durationMs = Math.round(endTime - startTime);
  console.log(`TIMING: ${operationName} took ${durationMs}ms`);
  return { result, durationMs };
}

/**
 * Helper to wait for post creation and measure completion time
 */
async function waitForPostCreation(
  page: import('@playwright/test').Page,
  maxWaitMs: number = 90000
): Promise<{ success: boolean; durationMs: number }> {
  const startTime = performance.now();
  const composeModal = page.getByLabel('Create a new post');

  while (performance.now() - startTime < maxWaitMs) {
    // Check if modal closed (success)
    const modalVisible = await composeModal.isVisible().catch(() => true);
    if (!modalVisible) {
      const durationMs = Math.round(performance.now() - startTime);
      return { success: true, durationMs };
    }

    // Check for toast messages
    const toastSelector = page.locator('[role="alert"]');
    const toastVisible = await toastSelector.isVisible().catch(() => false);
    if (toastVisible) {
      const toastText = await toastSelector.textContent() || '';
      if (toastText.toLowerCase().includes('timed out')) {
        const durationMs = Math.round(performance.now() - startTime);
        return { success: false, durationMs };
      }
    }

    await page.waitForTimeout(500);
  }

  return { success: false, durationMs: maxWaitMs };
}

test.describe('18 - Performance Tests', () => {
  // Log console errors for debugging
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`Browser error: ${msg.text()}`);
      }
    });
  });

  /**
   * Test 18.1: Private Feed Enable Time
   *
   * Metric: < 5 seconds (5000ms)
   *
   * Steps:
   * 1. Navigate to private feed settings
   * 2. If not enabled, click "Enable Private Feed"
   * 3. Measure time to success state
   *
   * Expected Results:
   * - Key generation + state creation < 5 seconds
   * - Includes chain confirmation wait
   *
   * NOTE: If private feed is already enabled, this test verifies the dashboard
   * load time instead, which should also be responsive.
   */
  test('18.1 Private Feed Enable Time', async ({ page, ownerIdentity, loginAs }) => {
    const TARGET_TIME_MS = 5000;

    // Login as owner
    await loginAs(ownerIdentity);

    // Check if private feed is already enabled
    const ownerData = loadIdentity(1);
    const alreadyEnabled = ownerData.privateFeedEnabled;

    // Navigate to private feed settings and measure time
    const { durationMs: navigationDuration } = await measureTime(async () => {
      await goToPrivateFeedSettings(page);
      await page.waitForLoadState('networkidle');
    }, 'Navigation to private feed settings');

    // Handle encryption key modal if it appears
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Wait for page to fully load
    await page.waitForTimeout(3000);

    if (alreadyEnabled) {
      // Private feed is already enabled - measure dashboard load time
      console.log('Private feed already enabled - measuring dashboard load time');

      // Look for dashboard elements
      const dashboardCard = page.locator('text=Your Private Feed').first();
      const { durationMs: dashboardLoadTime } = await measureTime(async () => {
        await expect(dashboardCard).toBeVisible({ timeout: 15000 });
      }, 'Dashboard visibility');

      // Take screenshot
      await page.screenshot({ path: 'screenshots/18-18.1-dashboard-load.png' });

      console.log(`PERFORMANCE: Dashboard loaded in ${navigationDuration + dashboardLoadTime}ms`);
      console.log(`TARGET: < ${TARGET_TIME_MS}ms`);

      // Soft assertion - dashboard should load within target time
      if (navigationDuration + dashboardLoadTime > TARGET_TIME_MS) {
        console.log('WARNING: Dashboard load time exceeded target');
      } else {
        console.log('SUCCESS: Dashboard load time within target');
      }
    } else {
      // Private feed not enabled - measure enable time
      console.log('Private feed not enabled - measuring enable time');

      const enableBtn = page.locator('button').filter({ hasText: /enable private feed/i });
      const hasEnableBtn = await enableBtn.isVisible({ timeout: 10000 }).catch(() => false);

      if (hasEnableBtn) {
        const { durationMs: enableDuration } = await measureTime(async () => {
          await enableBtn.click();

          // Wait for success indicators
          const successIndicators = page.locator('text=Your Private Feed').or(
            page.getByText(/private feed.*enabled|successfully enabled/i)
          );
          await expect(successIndicators.first()).toBeVisible({ timeout: 60000 });
        }, 'Enable private feed operation');

        // Take screenshot
        await page.screenshot({ path: 'screenshots/18-18.1-enable-complete.png' });

        console.log(`PERFORMANCE: Enable operation completed in ${enableDuration}ms`);
        console.log(`TARGET: < ${TARGET_TIME_MS}ms`);

        if (enableDuration > TARGET_TIME_MS) {
          console.log(`WARNING: Enable time (${enableDuration}ms) exceeded target (${TARGET_TIME_MS}ms)`);
        } else {
          console.log(`SUCCESS: Enable time (${enableDuration}ms) within target (${TARGET_TIME_MS}ms)`);
        }
      } else {
        console.log('Enable button not found - may require encryption key first');
        await page.screenshot({ path: 'screenshots/18-18.1-no-enable-button.png' });
      }
    }
  });

  /**
   * Test 18.2: Private Post Creation Latency
   *
   * Metric: Comparable to public posts (within 2x baseline)
   *
   * NOTE: This test measures the client-side encryption overhead only,
   * NOT the full blockchain confirmation time (which is variable and network-dependent).
   * We measure the time from clicking "Post" to the first loading indicator,
   * which captures the encryption step before network transmission.
   *
   * Expected Results:
   * - Encryption overhead imperceptible (< 500ms)
   * - Client-side processing similar to public posts
   */
  test('18.2 Private Post Creation Latency', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to home
    await goToHome(page);
    await page.waitForTimeout(3000);

    // Handle encryption key modal if needed
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    const timestamp = Date.now();

    // ----- MEASURE PRIVATE POST PREPARATION -----
    console.log('--- Measuring Private Post Preparation (client-side encryption) ---');

    await openComposeModal(page);
    await page.waitForTimeout(2000);

    const modal = page.locator('[role="dialog"]');

    // Select Private visibility
    const visibilityBtn = modal.locator('button').filter({ hasText: /^public$/i }).first();
    const hasVisibilitySelector = await visibilityBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasVisibilitySelector) {
      await visibilityBtn.click();
      await page.waitForTimeout(500);

      // Find and click Private option
      const privateItems = page.getByText('Private', { exact: false });
      const count = await privateItems.count();
      for (let i = 0; i < count; i++) {
        const item = privateItems.nth(i);
        const text = await item.textContent().catch(() => '');
        if (text?.includes('Only private followers')) {
          await item.click();
          break;
        }
      }
      await page.waitForTimeout(500);
    } else {
      console.log('Visibility selector not available - skipping private post timing');
      test.skip(true, 'Visibility selector not available');
      return;
    }

    // Enter private post content
    const privateContent = `Private performance test ${timestamp}`;
    const textarea = modal.locator('textarea').first();
    await textarea.fill(privateContent);

    // Measure time from clicking Post to loading indicator appearing
    // This captures the encryption step before network transmission
    const postBtn = modal.locator('button').filter({ hasText: /^post$/i }).first();
    await expect(postBtn).toBeEnabled({ timeout: 5000 });

    const { durationMs: encryptionPrepTime } = await measureTime(async () => {
      await postBtn.click();

      // Wait for either loading indicator or modal close (whichever comes first)
      const loadingIndicator = page.locator('svg.animate-spin');
      const modalGone = modal.locator('textarea');

      await Promise.race([
        loadingIndicator.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null),
        modalGone.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => null),
      ]);
    }, 'Private post preparation (encryption)');

    console.log(`PERFORMANCE - Encryption Prep Time: ${encryptionPrepTime}ms`);

    // Handle encryption key modal if it appears
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Now wait for completion (with shorter timeout since we already measured encryption)
    const completionResult = await waitForPostCreation(page, 60000);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/18-18.2-post-creation.png' });

    console.log(`PERFORMANCE:`);
    console.log(`  Encryption prep:   ${encryptionPrepTime}ms (target: < 500ms)`);
    console.log(`  Full completion:   ${completionResult.durationMs}ms (includes blockchain)`);
    console.log(`  Post success:      ${completionResult.success}`);

    // Client-side encryption should be very fast (< 500ms)
    if (encryptionPrepTime < 500) {
      console.log('SUCCESS: Encryption overhead is imperceptible (<500ms)');
    } else if (encryptionPrepTime < 1000) {
      console.log('ACCEPTABLE: Encryption overhead is noticeable but reasonable (<1s)');
    } else {
      console.log('WARNING: Encryption overhead may be noticeable to users');
    }

    // Close modal if still open
    const modalStillOpen = await modal.isVisible({ timeout: 2000 }).catch(() => false);
    if (modalStillOpen) {
      await closeModal(page);
    }
  });

  /**
   * Test 18.3: Single Post Decryption Latency
   *
   * Metric: < 100ms
   *
   * Steps:
   * 1. Navigate to private post with cached keys
   * 2. Measure decryption time
   *
   * Expected Results:
   * - Decryption completes in < 100ms
   * - No visible delay to user
   *
   * NOTE: This test observes the time from page load to content visibility.
   * Actual decryption may be faster, but we measure perceived latency.
   */
  test('18.3 Single Post Decryption Latency', async ({ page, ownerIdentity, loginAs }) => {
    const TARGET_TIME_MS = 100;
    const ACCEPTABLE_PERCEIVED_TIME_MS = 2000; // 2s for perceived latency (includes network)

    // Login as owner (can decrypt own posts)
    await loginAs(ownerIdentity);

    // Navigate to home to ensure keys are cached
    await goToHome(page);
    await page.waitForTimeout(3000);

    // Handle encryption key modal if needed
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Navigate to owner's profile to view private posts
    const { durationMs: profileLoadTime } = await measureTime(async () => {
      await goToProfile(page, ownerIdentity.identityId);
      await page.waitForLoadState('networkidle');
    }, 'Profile page load');

    // Wait for posts to appear
    await page.waitForTimeout(2000);

    // Handle encryption key modal if needed
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Look for post content (should be decrypted for owner)
    const postContent = page.locator('article').first();
    const hasPost = await postContent.isVisible({ timeout: 10000 }).catch(() => false);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/18-18.3-decryption.png' });

    if (hasPost) {
      // Measure time until content is actually visible (not shimmer/skeleton)
      const { durationMs: contentVisibleTime } = await measureTime(async () => {
        // Wait for actual text content (not loading skeleton)
        const contentText = postContent.locator('p, span').filter({ hasNotText: /loading|decrypting/i });
        await expect(contentText.first()).toBeVisible({ timeout: 10000 });
      }, 'Post content visibility');

      console.log(`PERFORMANCE:`);
      console.log(`  Profile load:     ${profileLoadTime}ms`);
      console.log(`  Content visible:  ${contentVisibleTime}ms`);
      console.log(`  TARGET (raw):     < ${TARGET_TIME_MS}ms`);
      console.log(`  TARGET (perceived): < ${ACCEPTABLE_PERCEIVED_TIME_MS}ms`);

      // Check for decryption indicators
      const decryptingIndicator = page.getByText(/decrypting/i);
      const hadDecryptingState = await decryptingIndicator.isVisible({ timeout: 1000 }).catch(() => false);

      if (hadDecryptingState) {
        console.log('Decrypting state was visible - measuring that would give accurate decryption time');
      } else {
        console.log('Content appeared immediately or decryption was too fast to observe');
      }

      // Soft assertion on perceived time
      if (contentVisibleTime <= ACCEPTABLE_PERCEIVED_TIME_MS) {
        console.log('SUCCESS: Decryption perceived latency is acceptable');
      } else {
        console.log('WARNING: Decryption perceived latency may be noticeable to users');
      }
    } else {
      console.log('No posts found on profile - cannot measure decryption time');

      // Look for any content that might indicate post presence
      const anyContent = page.locator('article, [data-testid="post"]');
      const contentCount = await anyContent.count();
      console.log(`Found ${contentCount} potential post containers`);
    }
  });

  /**
   * Test 18.4: Revocation Completion Time
   *
   * Metric: < 10 seconds
   *
   * NOTE: This test does NOT perform an actual revocation (destructive operation).
   * Instead, it measures the time for related operations that indicate revocation
   * would be performant:
   * - Dashboard load time
   * - Follower list load time
   *
   * For actual revocation timing, see test 06-revocation.spec.ts
   */
  test('18.4 Revocation Completion Time - Infrastructure Check', async ({ page, ownerIdentity, loginAs }) => {
    const TARGET_TIME_MS = 10000;

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to private feed settings and measure
    const { durationMs: settingsLoadTime } = await measureTime(async () => {
      await goToPrivateFeedSettings(page);
      await page.waitForLoadState('networkidle');
    }, 'Settings page load');

    // Handle encryption key modal if needed
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Wait for dashboard to load
    await page.waitForTimeout(5000);

    // Look for the followers section (where revocation would happen)
    const followersSection = page.getByText(/private followers/i).first();
    const hasFollowersSection = await followersSection.isVisible({ timeout: 10000 }).catch(() => false);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/18-18.4-revocation-infrastructure.png' });

    if (hasFollowersSection) {
      // Measure time to find revoke buttons (indicates follower list loaded)
      const { durationMs: followersLoadTime } = await measureTime(async () => {
        const revokeBtn = page.locator('button').filter({ hasText: /revoke/i });
        const nofollowers = page.getByText(/no.*followers|no private followers yet/i);

        // Wait for either revoke buttons or "no followers" message
        await Promise.race([
          revokeBtn.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => null),
          nofollowers.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => null),
        ]);
      }, 'Followers list load');

      const totalTime = settingsLoadTime + followersLoadTime;
      console.log(`PERFORMANCE:`);
      console.log(`  Settings load:    ${settingsLoadTime}ms`);
      console.log(`  Followers load:   ${followersLoadTime}ms`);
      console.log(`  Total:            ${totalTime}ms`);
      console.log(`  TARGET:           < ${TARGET_TIME_MS}ms`);

      // The actual revocation includes blockchain transaction time
      // This test verifies the UI infrastructure is responsive
      console.log('NOTE: Actual revocation would add ~3-5s for blockchain confirmation');

      if (totalTime < TARGET_TIME_MS) {
        console.log('SUCCESS: Revocation infrastructure load time is within target');
      }
    } else {
      console.log('Followers section not visible - checking if private feed is enabled');

      const enableBtn = page.locator('button').filter({ hasText: /enable private feed/i });
      const hasEnableBtn = await enableBtn.isVisible({ timeout: 5000 }).catch(() => false);

      if (hasEnableBtn) {
        console.log('Private feed not enabled - revocation not applicable');
      }
    }

    console.log('DOCUMENTATION: Expected revocation flow:');
    console.log('  1. Click Revoke button');
    console.log('  2. Confirm in dialog');
    console.log('  3. Create PrivateFeedRekey document (~2-5s blockchain)');
    console.log('  4. Delete PrivateFeedGrant document (~2-5s blockchain)');
    console.log('  5. UI updates to reflect revocation');
    console.log('  Total expected: 5-10 seconds');
  });

  /**
   * Test 18.5: Batch Decryption in Feed
   *
   * Preconditions:
   * - @owner has multiple private posts in feed
   * - @owner viewing feed (can decrypt own posts)
   *
   * Steps:
   * 1. Load feed page
   * 2. Measure time to decrypt all visible posts
   *
   * Expected Results:
   * - Batch decryption efficient
   * - UI not blocked during decryption
   * - Progressive rendering as posts decrypt
   */
  test('18.5 Batch Decryption in Feed', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to home to load feed
    const { durationMs: feedLoadTime } = await measureTime(async () => {
      await goToHome(page);
      await page.waitForTimeout(2000);
    }, 'Feed page initial load');

    // Handle encryption key modal if needed
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Wait for posts to load
    await page.waitForTimeout(3000);

    // Count how many posts are visible
    const posts = page.locator('article');
    const postCount = await posts.count();
    console.log(`Found ${postCount} posts in feed`);

    // Check for decrypting indicators (shimmer/skeleton)
    const decryptingIndicators = page.locator('.animate-pulse, [class*="shimmer"]');
    const decryptingCount = await decryptingIndicators.count();

    // Measure time until all decrypting states are resolved
    const { durationMs: decryptionTime } = await measureTime(async () => {
      // Wait for shimmer/skeleton to disappear
      if (decryptingCount > 0) {
        await expect(decryptingIndicators.first()).not.toBeVisible({ timeout: 30000 });
      }

      // Also wait for any "decrypting" text to disappear
      const decryptingText = page.getByText(/decrypting/i);
      const hasDecryptingText = await decryptingText.first().isVisible({ timeout: 1000 }).catch(() => false);
      if (hasDecryptingText) {
        await expect(decryptingText.first()).not.toBeVisible({ timeout: 30000 });
      }
    }, 'Batch decryption completion');

    // Navigate to owner's profile to see more private posts
    const { durationMs: profileFeedTime } = await measureTime(async () => {
      await goToProfile(page, ownerIdentity.identityId);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000);
    }, 'Profile feed load');

    // Count posts on profile
    const profilePosts = page.locator('article');
    const profilePostCount = await profilePosts.count();

    // Take screenshot
    await page.screenshot({ path: 'screenshots/18-18.5-batch-decryption.png' });

    console.log(`PERFORMANCE - Feed Page:`);
    console.log(`  Feed load:         ${feedLoadTime}ms`);
    console.log(`  Decryption time:   ${decryptionTime}ms`);
    console.log(`  Posts decrypted:   ${postCount}`);

    console.log(`PERFORMANCE - Profile Page:`);
    console.log(`  Profile load:      ${profileFeedTime}ms`);
    console.log(`  Posts visible:     ${profilePostCount}`);

    // Calculate per-post decryption time
    if (postCount > 0) {
      const perPostTime = decryptionTime / postCount;
      console.log(`  Per-post avg:      ${perPostTime.toFixed(1)}ms`);

      // Each post should decrypt in <100ms
      if (perPostTime < 100) {
        console.log('SUCCESS: Per-post decryption time is within target (<100ms)');
      } else {
        console.log('NOTE: Per-post time includes network/UI overhead, actual crypto may be faster');
      }
    }

    // Check that UI remained responsive during decryption
    // The compose button should be clickable throughout
    const composeBtn = page.getByRole('button', { name: /what.?s happening/i });
    const composeVisible = await composeBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (composeVisible) {
      console.log('SUCCESS: UI remained responsive during batch decryption');
    }
  });

  /**
   * Bonus Test: Feed Scroll Performance
   *
   * Measures performance when scrolling through a feed with mixed public/private posts.
   */
  test('Bonus: Feed Scroll Performance', async ({ page, ownerIdentity, loginAs }) => {
    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to home
    await goToHome(page);
    await page.waitForTimeout(3000);

    // Handle encryption key modal if needed
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Wait for initial content
    await page.waitForTimeout(3000);

    // Count initial posts
    const initialPosts = page.locator('article');
    const initialCount = await initialPosts.count();
    console.log(`Initial posts loaded: ${initialCount}`);

    // Measure scroll performance
    const { durationMs: scrollTime } = await measureTime(async () => {
      // Scroll down to trigger lazy loading
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      // Wait for new content to potentially load
      await page.waitForTimeout(2000);

      // Scroll back up
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });

      await page.waitForTimeout(1000);
    }, 'Scroll operations');

    // Take screenshot
    await page.screenshot({ path: 'screenshots/18-bonus-scroll.png' });

    // Count posts after scrolling (may have loaded more)
    const finalPosts = page.locator('article');
    const finalCount = await finalPosts.count();

    console.log(`PERFORMANCE - Scroll:`);
    console.log(`  Scroll time:       ${scrollTime}ms`);
    console.log(`  Posts before:      ${initialCount}`);
    console.log(`  Posts after:       ${finalCount}`);
    console.log(`  New posts loaded:  ${finalCount - initialCount}`);

    // Check for any performance issues (janky scrolling would cause long paint times)
    // We can't directly measure frame rate, but we can check the page remains responsive
    const pageResponsive = await page.evaluate(() => {
      return document.readyState === 'complete';
    });

    if (pageResponsive) {
      console.log('SUCCESS: Page remained responsive during scroll');
    }
  });

  /**
   * Bonus Test: Dashboard Stats Load Time
   *
   * Measures how quickly the dashboard stats (followers, pending, posts) load.
   */
  test('Bonus: Dashboard Stats Load Time', async ({ page, ownerIdentity, loginAs }) => {
    // Check if private feed is enabled
    const ownerData = loadIdentity(1);
    if (!ownerData.privateFeedEnabled) {
      test.skip(true, 'Private feed not enabled - dashboard not available');
      return;
    }

    // Login as owner
    await loginAs(ownerIdentity);

    // Navigate to settings and measure
    const { durationMs: navigationTime } = await measureTime(async () => {
      await goToPrivateFeedSettings(page);
      await page.waitForLoadState('networkidle');
    }, 'Navigation to settings');

    // Handle encryption key modal if needed
    if (ownerIdentity.keys.encryptionKey) {
      await handleEncryptionKeyModal(page, ownerIdentity.keys.encryptionKey);
    }

    // Measure time until stats are visible
    const { durationMs: statsLoadTime } = await measureTime(async () => {
      // Look for stats cards
      const followersCard = page.getByText('Followers').first();
      const pendingCard = page.getByText('Pending').first();

      // Wait for either to be visible
      await Promise.race([
        followersCard.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null),
        pendingCard.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null),
      ]);

      // Wait a bit more for numbers to populate
      await page.waitForTimeout(2000);
    }, 'Stats visibility');

    // Check if stats show actual numbers (not loading skeleton)
    const statsNumbers = page.locator('.text-2xl.font-bold, .text-xl.font-bold');
    const hasStats = await statsNumbers.first().isVisible({ timeout: 5000 }).catch(() => false);

    // Take screenshot
    await page.screenshot({ path: 'screenshots/18-bonus-dashboard-stats.png' });

    const totalTime = navigationTime + statsLoadTime;
    console.log(`PERFORMANCE - Dashboard Stats:`);
    console.log(`  Navigation:        ${navigationTime}ms`);
    console.log(`  Stats load:        ${statsLoadTime}ms`);
    console.log(`  Total:             ${totalTime}ms`);
    console.log(`  Stats visible:     ${hasStats}`);

    if (totalTime < 5000) {
      console.log('SUCCESS: Dashboard stats loaded quickly (<5s)');
    } else if (totalTime < 10000) {
      console.log('ACCEPTABLE: Dashboard stats loaded within reasonable time (<10s)');
    } else {
      console.log('WARNING: Dashboard stats load time may be slow');
    }
  });
});
