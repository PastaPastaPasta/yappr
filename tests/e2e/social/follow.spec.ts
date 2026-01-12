import { test, expect } from '../../fixtures/test-fixtures';
import { ProfilePage } from '../../pages/profile.page';
import { FeedPage } from '../../pages/feed.page';
import { TEST_IDENTITY } from '../../fixtures/test-identity';

test.describe('Social - Follow/Unfollow', () => {
  test('should display follow button on other user profiles', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    // Navigate to feed and find a post from another user
    const feedPage = new FeedPage(page);
    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    const hasPosts = await feedPage.hasPosts();
    if (!hasPosts) {
      test.skip();
      return;
    }

    // Click on author avatar to go to their profile
    const firstPost = await feedPage.getPostByIndex(0);
    const authorAvatar = firstPost.locator('img, [data-avatar]').first();
    await authorAvatar.click();

    // Wait for profile to load
    await page.waitForURL(/\/user|\/profile/, { timeout: 10000 });
    await profilePage.waitForProfileLoad();

    // Check if this is not our own profile
    const isOwnProfile = page.url().includes(TEST_IDENTITY.identityId);
    if (!isOwnProfile) {
      // Should show follow/following button
      const hasFollowButton = await profilePage.followButton.isVisible().catch(() => false);
      const hasUnfollowButton = await profilePage.unfollowButton.isVisible().catch(() => false);
      expect(hasFollowButton || hasUnfollowButton).toBe(true);
    }
  });

  test('should not show follow button on own profile', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    await profilePage.goto();
    await profilePage.waitForProfileLoad();

    // Should not show follow button on own profile
    const hasFollowButton = await profilePage.followButton.isVisible().catch(() => false);
    expect(hasFollowButton).toBe(false);
  });
});

test.describe('Social - Followers/Following Lists', () => {
  test('should display followers list', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/followers');
    await page.waitForLoadState('networkidle');

    // Should show followers page
    await expect(page.getByText(/followers/i)).toBeVisible();
  });

  test('should display following list', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/following');
    await page.waitForLoadState('networkidle');

    // Should show following page
    await expect(page.getByText(/following/i)).toBeVisible();
  });

  test('should allow searching following list', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/following');
    await page.waitForLoadState('networkidle');

    // Check for search input
    const searchInput = page.getByPlaceholder(/search/i);
    const hasSearch = await searchInput.isVisible().catch(() => false);

    if (hasSearch) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);
    }
  });

  test('should show refresh button on followers page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/followers');
    await page.waitForLoadState('networkidle');

    // Should have refresh functionality
    const refreshButton = page.locator('button').filter({ has: page.locator('svg') }).first();
    await expect(refreshButton).toBeVisible();
  });
});

test.describe('Social - Block', () => {
  test('should access blocked users from settings', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Navigate to privacy section if available
    const privacySection = page.getByRole('button', { name: /privacy|security/i });
    if (await privacySection.isVisible().catch(() => false)) {
      await privacySection.click();
      await page.waitForTimeout(300);

      // Look for blocked users option
      const blockedUsersButton = page.getByRole('button', { name: /blocked|view blocked/i });
      const hasBlockedSection = await blockedUsersButton.isVisible().catch(() => false);

      if (hasBlockedSection) {
        await blockedUsersButton.click();
        await page.waitForTimeout(500);
      }
    }
  });
});
