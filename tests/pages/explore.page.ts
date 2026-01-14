import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class ExplorePage extends BasePage {
  // Search input
  get searchInput() {
    return this.page.getByPlaceholder(/search/i);
  }

  // Back button (when search is focused)
  get searchBackButton() {
    return this.page.getByRole('button', { name: /back/i });
  }

  // Search results
  get searchResults() {
    return this.page.locator('article, [data-post-id]');
  }

  get noResultsMessage() {
    return this.page.getByText(/no results|nothing found/i);
  }

  // Trending hashtags section
  get trendingSection() {
    return this.page.locator('section, div').filter({ hasText: /trending/i });
  }

  get trendingHashtags() {
    return this.page.locator('a, button').filter({ hasText: /^#/ });
  }

  // Loading indicator
  get loadingIndicator() {
    return this.page.getByText(/loading|searching/i);
  }

  async goto() {
    await this.page.goto('/explore');
    await this.waitForPageLoad();
  }

  // Search for content
  async search(query: string) {
    await this.searchInput.fill(query);
    // Wait for debounce
    await this.page.waitForTimeout(400);
    // Wait for results
    await this.page.waitForLoadState('networkidle');
  }

  // Clear search
  async clearSearch() {
    await this.searchInput.clear();
    await this.page.waitForTimeout(200);
  }

  // Click on a trending hashtag
  async clickHashtag(index: number = 0) {
    await this.trendingHashtags.nth(index).click();
    await this.page.waitForURL(/\/hashtag/);
  }

  // Get search results count
  async getSearchResultsCount(): Promise<number> {
    await this.page.waitForTimeout(500);
    return await this.searchResults.count();
  }

  // Get trending hashtags count
  async getTrendingHashtagsCount(): Promise<number> {
    return await this.trendingHashtags.count();
  }

  // Check if search is focused
  async isSearchFocused(): Promise<boolean> {
    return await this.searchInput.evaluate((el) => document.activeElement === el);
  }
}
