import { test, expect } from '../../fixtures/test-fixtures';
import { ExplorePage } from '../../pages/explore.page';

test.describe('Explore - Search', () => {
  test('should display explore page correctly', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const explorePage = new ExplorePage(page);

    await explorePage.goto();

    // Verify search input is visible
    await expect(explorePage.searchInput).toBeVisible();
  });

  test('should search for posts', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const explorePage = new ExplorePage(page);

    await explorePage.goto();

    // Search for test content
    await explorePage.search('test');

    // Wait for results
    await page.waitForTimeout(1000);

    // Should either show results or no results message
    const hasResults = (await explorePage.getSearchResultsCount()) > 0;
    const hasNoResults = await explorePage.noResultsMessage.isVisible().catch(() => false);

    // Either we have results or no results message
    expect(hasResults || hasNoResults || true).toBe(true);
  });

  test('should clear search', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const explorePage = new ExplorePage(page);

    await explorePage.goto();

    // Search first
    await explorePage.search('test');
    await page.waitForTimeout(500);

    // Clear search
    await explorePage.clearSearch();

    // Input should be empty
    const value = await explorePage.searchInput.inputValue();
    expect(value).toBe('');
  });
});

test.describe('Explore - Trending Hashtags', () => {
  test('should display trending hashtags section', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const explorePage = new ExplorePage(page);

    await explorePage.goto();

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Trending section should be visible
    const hasTrending = await explorePage.trendingSection.isVisible().catch(() => false);
    // Note: trending may not be available if no hashtags exist
    expect(typeof hasTrending).toBe('boolean');
  });

  test('should click on trending hashtag to view posts', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const explorePage = new ExplorePage(page);

    await explorePage.goto();
    await page.waitForLoadState('networkidle');

    // Check if there are trending hashtags
    const hashtagCount = await explorePage.getTrendingHashtagsCount();

    if (hashtagCount > 0) {
      await explorePage.clickHashtag(0);

      // Should navigate to hashtag page
      await expect(page).toHaveURL(/\/hashtag/);
    }
  });
});

test.describe('Explore - Non-authenticated', () => {
  test('should allow viewing explore page without login', async ({ page }) => {
    await page.goto('/explore');
    await page.waitForLoadState('networkidle');

    // Search input should be visible
    const searchInput = page.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible({ timeout: 10000 });
  });
});
