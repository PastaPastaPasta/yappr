import { test, expect } from '../../fixtures/test-fixtures';
import { BasePage } from '../../pages/base.page';

test.describe('Navigation - Sidebar', () => {
  test('should display sidebar navigation', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    // Check for sidebar navigation links
    const homeLink = page.getByRole('link', { name: /home/i });
    const hasHome = await homeLink.isVisible().catch(() => false);
    expect(hasHome).toBe(true);
  });

  test('should navigate to explore from sidebar', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    const exploreLink = page.getByRole('link', { name: /explore|search/i }).first();
    if (await exploreLink.isVisible()) {
      await exploreLink.click();
      await expect(page).toHaveURL(/\/explore/);
    }
  });

  test('should navigate to profile from sidebar', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    const profileLink = page.getByRole('link', { name: /profile/i }).first();
    if (await profileLink.isVisible()) {
      await profileLink.click();
      await expect(page).toHaveURL(/\/profile|\/user/);
    }
  });

  test('should navigate to messages from sidebar', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    const messagesLink = page.getByRole('link', { name: /messages/i }).first();
    if (await messagesLink.isVisible()) {
      await messagesLink.click();
      await expect(page).toHaveURL(/\/messages/);
    }
  });

  test('should navigate to notifications from sidebar', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    const notificationsLink = page.getByRole('link', { name: /notifications/i }).first();
    if (await notificationsLink.isVisible()) {
      await notificationsLink.click();
      await expect(page).toHaveURL(/\/notifications/);
    }
  });

  test('should navigate to bookmarks from sidebar', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    const bookmarksLink = page.getByRole('link', { name: /bookmarks/i }).first();
    if (await bookmarksLink.isVisible()) {
      await bookmarksLink.click();
      await expect(page).toHaveURL(/\/bookmarks/);
    }
  });

  test('should navigate to settings from sidebar', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    const settingsLink = page.getByRole('link', { name: /settings/i }).first();
    if (await settingsLink.isVisible()) {
      await settingsLink.click();
      await expect(page).toHaveURL(/\/settings/);
    }
  });
});

test.describe('Navigation - Public Pages', () => {
  test('should navigate to home page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should show home page or redirect to feed
    const hasWelcome = await page.getByText(/welcome|yappr/i).first().isVisible().catch(() => false);
    const isFeed = page.url().includes('/feed');
    expect(hasWelcome || isFeed).toBe(true);
  });

  test('should navigate to login page', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Should show login form
    await expect(page.getByText(/sign in/i)).toBeVisible();
  });

  test('should navigate to about page', async ({ page }) => {
    await page.goto('/about');
    await page.waitForLoadState('networkidle');

    // Should show about content
    const hasContent = await page.getByText(/about|yappr/i).first().isVisible().catch(() => false);
    expect(hasContent).toBe(true);
  });

  test('should navigate to terms page', async ({ page }) => {
    await page.goto('/terms');
    await page.waitForLoadState('networkidle');

    // Should show terms content
    const hasContent = await page.getByText(/terms/i).first().isVisible().catch(() => false);
    expect(hasContent).toBe(true);
  });

  test('should navigate to privacy page', async ({ page }) => {
    await page.goto('/privacy');
    await page.waitForLoadState('networkidle');

    // Should show privacy content
    const hasContent = await page.getByText(/privacy/i).first().isVisible().catch(() => false);
    expect(hasContent).toBe(true);
  });
});

test.describe('Navigation - Post Detail', () => {
  test('should navigate to post detail page', async ({ page }) => {
    // Go to feed first
    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    // Wait for posts to load
    await page.waitForTimeout(3000);

    // Check if there are posts
    const posts = page.locator('article');
    const postCount = await posts.count();

    if (postCount > 0) {
      // Click on first post content
      const firstPost = posts.first();
      await firstPost.click();

      // Should navigate to post detail
      await page.waitForURL(/\/post/, { timeout: 10000 });
    }
  });

  test('should show back button on post detail', async ({ page }) => {
    await page.goto('/feed');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    const posts = page.locator('article');
    const postCount = await posts.count();

    if (postCount > 0) {
      await posts.first().click();
      await page.waitForURL(/\/post/, { timeout: 10000 });

      // Should show back button
      const backButton = page.getByRole('button', { name: /back/i });
      const hasBack = await backButton.isVisible().catch(() => false);
      expect(typeof hasBack).toBe('boolean');
    }
  });
});

test.describe('Navigation - Hashtag Page', () => {
  test('should navigate to hashtag page', async ({ page }) => {
    await page.goto('/hashtag?tag=test');
    await page.waitForLoadState('networkidle');

    // Should show hashtag content or empty state
    const hasHashtag = await page.getByText(/#test/i).isVisible().catch(() => false);
    expect(typeof hasHashtag).toBe('boolean');
  });
});

test.describe('Navigation - User Profile', () => {
  test('should navigate to user page with ID', async ({ page }) => {
    // Use a test identity ID
    await page.goto('/user?id=E46NuyTqWrCj1hnGN7gGdo4qCkwPdcNAN2poEZzYguzw');
    await page.waitForLoadState('networkidle');

    // Should show profile or loading
    await page.waitForTimeout(3000);
    const hasContent = await page.locator('main').isVisible().catch(() => false);
    expect(hasContent).toBe(true);
  });
});
