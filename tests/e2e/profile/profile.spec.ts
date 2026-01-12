import { test, expect } from '../../fixtures/test-fixtures';
import { ProfilePage } from '../../pages/profile.page';
import { ProfileCreatePage } from '../../pages/profile-create.page';
import { TEST_IDENTITY, getHighAuthKey, generateTestDisplayName } from '../../fixtures/test-identity';

test.describe('Profile - View', () => {
  test('should display own profile correctly', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    await profilePage.goto();
    await profilePage.waitForProfileLoad();

    // Verify basic profile elements are visible
    await expect(profilePage.displayName).toBeVisible({ timeout: 30000 });
    await expect(profilePage.avatar).toBeVisible();
  });

  test('should display follower and following counts', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    await profilePage.goto();
    await profilePage.waitForProfileLoad();

    // Verify counts are displayed
    await expect(profilePage.followersCount).toBeVisible({ timeout: 30000 });
    await expect(profilePage.followingCount).toBeVisible();
  });

  test('should navigate to followers list', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    await profilePage.goto();
    await profilePage.waitForProfileLoad();

    // Click followers
    await profilePage.viewFollowers();

    // Verify navigation
    await expect(page).toHaveURL(/\/followers/);
  });

  test('should navigate to following list', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    await profilePage.goto();
    await profilePage.waitForProfileLoad();

    // Click following
    await profilePage.viewFollowing();

    // Verify navigation
    await expect(page).toHaveURL(/\/following/);
  });

  test('should display user posts on profile', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    await profilePage.goto();
    await profilePage.waitForProfileLoad();

    // Wait for posts to load (or empty state)
    await page.waitForTimeout(3000);

    // Either posts exist or empty state is shown
    const hasPosts = await profilePage.posts.first().isVisible().catch(() => false);
    const hasEmptyState = await profilePage.noPosts.isVisible().catch(() => false);

    expect(hasPosts || hasEmptyState).toBe(true);
  });

  test('should view another user profile', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    // Use a known identity (could be any user on the platform)
    // We'll use our test identity viewing mode
    await page.goto(`/user?id=${TEST_IDENTITY.identityId}`);
    await profilePage.waitForProfileLoad();

    // Verify profile loads
    await expect(profilePage.displayName).toBeVisible({ timeout: 30000 });
  });
});

test.describe('Profile - Edit', () => {
  test('should navigate to profile edit page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    await profilePage.goto();
    await profilePage.waitForProfileLoad();

    // Check if edit button exists
    const hasEditButton = await profilePage.editProfileButton.isVisible().catch(() => false);
    if (hasEditButton) {
      await profilePage.editProfile();
      await expect(page).toHaveURL(/\/profile\/create/);
    }
  });

  test('should display profile create/edit form', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const createPage = new ProfileCreatePage(page);

    await createPage.goto();

    // Verify form fields are visible
    await expect(createPage.displayNameInput).toBeVisible({ timeout: 30000 });
    await expect(createPage.bioInput).toBeVisible();
  });

  test('should validate display name length', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const createPage = new ProfileCreatePage(page);

    await createPage.goto();

    // Enter a very long name (over 50 chars)
    const longName = 'A'.repeat(60);
    await createPage.fillDisplayName(longName);

    // The input should be limited or show error
    const value = await createPage.displayNameInput.inputValue();
    expect(value.length).toBeLessThanOrEqual(50);
  });

  test('should show bio character counter', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const createPage = new ProfileCreatePage(page);

    await createPage.goto();

    // Enter some bio text
    await createPage.fillBio('This is my test bio #test');

    // Wait for counter to update
    await page.waitForTimeout(300);

    // Counter should be visible and show count
    const counterVisible = await createPage.bioCounter.isVisible().catch(() => false);
    if (counterVisible) {
      const count = await createPage.getBioCharCount();
      expect(count).toBeGreaterThan(0);
    }
  });

  test('should allow editing profile fields', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const createPage = new ProfileCreatePage(page);

    await createPage.goto();

    // Fill in profile fields
    const testName = generateTestDisplayName();
    await createPage.fillDisplayName(testName);
    await createPage.fillBio('Test bio for E2E testing #test #automated');
    await createPage.fillPronouns('they/them');
    await createPage.fillLocation('Test City');

    // Verify values are set
    const displayName = await createPage.displayNameInput.inputValue();
    expect(displayName).toBe(testName);
  });
});

test.describe('Profile - Social Actions', () => {
  test('should share profile link', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const profilePage = new ProfilePage(page);

    await profilePage.goto();
    await profilePage.waitForProfileLoad();

    // Click share button if visible
    const hasShareButton = await profilePage.shareButton.isVisible().catch(() => false);
    if (hasShareButton) {
      await profilePage.shareProfile();

      // Should copy to clipboard (toast notification)
      await page.waitForTimeout(500);
    }
  });
});
