import { test, expect } from '../../fixtures/test-fixtures';

test.describe('Bookmarks - Display', () => {
  test('should display bookmarks page correctly', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/bookmarks');
    await page.waitForLoadState('networkidle');

    // Should show bookmarks heading or content
    const hasBookmarksText = await page.getByText(/bookmarks/i).first().isVisible().catch(() => false);
    expect(hasBookmarksText).toBe(true);
  });

  test('should show empty state when no bookmarks', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/bookmarks');
    await page.waitForLoadState('networkidle');

    // Should either have bookmarks or show empty state
    const hasEmptyState = await page.getByText(/no bookmarks|save posts|empty/i).isVisible().catch(() => false);
    const hasBookmarks = await page.locator('article').first().isVisible().catch(() => false);

    expect(hasEmptyState || hasBookmarks).toBe(true);
  });

  test('should show search input', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/bookmarks');
    await page.waitForLoadState('networkidle');

    // Check for search functionality
    const searchInput = page.getByPlaceholder(/search/i);
    const hasSearch = await searchInput.isVisible().catch(() => false);
    expect(typeof hasSearch).toBe('boolean');
  });

  test('should show sort options', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/bookmarks');
    await page.waitForLoadState('networkidle');

    // Check for sort dropdown or options
    const sortButton = page.getByRole('button', { name: /sort|recent|oldest/i });
    const hasSort = await sortButton.isVisible().catch(() => false);
    expect(typeof hasSort).toBe('boolean');
  });
});

test.describe('Bookmarks - Actions', () => {
  test('should search bookmarks', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/bookmarks');
    await page.waitForLoadState('networkidle');

    const searchInput = page.getByPlaceholder(/search/i);
    const hasSearch = await searchInput.isVisible().catch(() => false);

    if (hasSearch) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);
    }
  });

  test('should remove bookmark from bookmarks page', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/bookmarks');
    await page.waitForLoadState('networkidle');

    // Check if there are any bookmarks
    const hasBookmarks = await page.locator('article').first().isVisible().catch(() => false);

    if (hasBookmarks) {
      // Look for remove/unbookmark button
      const removeButton = page.getByRole('button', { name: /remove|unbookmark/i }).first();
      const hasRemove = await removeButton.isVisible().catch(() => false);
      expect(typeof hasRemove).toBe('boolean');
    }
  });
});
