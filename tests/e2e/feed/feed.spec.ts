import { test, expect } from '../../fixtures/test-fixtures';
import { FeedPage } from '../../pages/feed.page';
import { PostCardComponent } from '../../pages/components/post-card.component';

test.describe('Feed - Display', () => {
  test('should display feed page correctly', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();

    // Verify header elements
    await expect(feedPage.homeTitle).toBeVisible();
    await expect(feedPage.forYouTab).toBeVisible();
    await expect(feedPage.followingTab).toBeVisible();
    await expect(feedPage.composeButton).toBeVisible();
  });

  test('should load posts from Dash Platform', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    // Should either have posts or empty state
    const hasPosts = await feedPage.hasPosts();
    const hasEmptyState = await feedPage.emptyState.isVisible().catch(() => false);

    expect(hasPosts || hasEmptyState).toBe(true);
  });

  test('should show refresh button', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();

    // Refresh button should be visible
    await expect(feedPage.refreshButton).toBeVisible();
  });

  test('should refresh feed when clicking refresh', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    // Refresh feed
    await feedPage.refreshFeed();

    // Feed should still be displayed (either with posts or empty)
    await expect(feedPage.homeTitle).toBeVisible();
  });
});

test.describe('Feed - Tabs', () => {
  test('should switch to For You tab', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    await feedPage.switchToForYou();

    // For You tab should be active
    const isActive = await feedPage.isForYouActive();
    expect(isActive).toBe(true);
  });

  test('should switch to Following tab', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    await feedPage.switchToFollowing();

    // Following tab should be active
    const isActive = await feedPage.isFollowingActive();
    expect(isActive).toBe(true);
  });

  test('should persist tab selection', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    // Switch to Following
    await feedPage.switchToFollowing();

    // Reload page
    await page.reload();
    await feedPage.waitForFeedLoad();

    // Should still be on Following tab
    const isFollowingActive = await feedPage.isFollowingActive();
    expect(isFollowingActive).toBe(true);
  });

  test('should show appropriate empty state for Following tab', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    await feedPage.switchToFollowing();
    await feedPage.waitForFeedLoad();

    // Should show posts or empty message about following
    const hasPosts = await feedPage.hasPosts();
    const hasEmptyState = await page.getByText(/following|empty|follow some/i).isVisible().catch(() => false);

    expect(hasPosts || hasEmptyState).toBe(true);
  });
});

test.describe('Feed - Pagination', () => {
  test('should show load more button when there are more posts', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    // Check if load more button is visible (only if there are enough posts)
    const postCount = await feedPage.getPostCount();
    if (postCount >= 20) {
      await expect(feedPage.loadMoreButton).toBeVisible();
    }
  });

  test('should load more posts when clicking load more', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    const initialCount = await feedPage.getPostCount();

    // Only test if load more is available
    const hasLoadMore = await feedPage.loadMoreButton.isVisible().catch(() => false);
    if (hasLoadMore) {
      await feedPage.loadMore();

      const newCount = await feedPage.getPostCount();
      expect(newCount).toBeGreaterThanOrEqual(initialCount);
    }
  });
});

test.describe('Feed - Post Interactions', () => {
  test('should like a post', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    const hasPosts = await feedPage.hasPosts();
    if (!hasPosts) {
      test.skip();
      return;
    }

    // Get first post
    const firstPostLocator = await feedPage.getPostByIndex(0);
    const postCard = new PostCardComponent(page, firstPostLocator);

    // Like the post
    await postCard.like();

    // Wait for like to register
    await page.waitForTimeout(2000);
  });

  test('should bookmark a post', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    const hasPosts = await feedPage.hasPosts();
    if (!hasPosts) {
      test.skip();
      return;
    }

    // Get first post
    const firstPostLocator = await feedPage.getPostByIndex(0);
    const postCard = new PostCardComponent(page, firstPostLocator);

    // Bookmark the post
    await postCard.bookmark();

    // Wait for bookmark to register
    await page.waitForTimeout(1000);
  });

  test('should navigate to post detail', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    const hasPosts = await feedPage.hasPosts();
    if (!hasPosts) {
      test.skip();
      return;
    }

    // Click on first post
    await feedPage.clickPost(0);

    // Should navigate to post detail
    await expect(page).toHaveURL(/\/post/);
  });
});

test.describe('Feed - Non-authenticated', () => {
  test('should show login prompt for non-authenticated users', async ({ page }) => {
    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    // Should show login prompt
    const loginPrompt = page.getByRole('link', { name: /login/i });
    await expect(loginPrompt).toBeVisible({ timeout: 10000 });
  });

  test('should allow viewing feed without login', async ({ page }) => {
    await page.goto('/feed');
    await page.waitForLoadState('networkidle');

    // Feed tabs should still be visible
    const forYouTab = page.getByRole('button', { name: /for you/i });
    await expect(forYouTab).toBeVisible({ timeout: 10000 });
  });
});
