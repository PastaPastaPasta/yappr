import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class FeedPage extends BasePage {
  // Header elements
  get homeTitle() {
    return this.page.locator('h1').filter({ hasText: 'Home' });
  }

  get refreshButton() {
    return this.page.locator('button').filter({ has: this.page.locator('svg[class*="ArrowPath"]') });
  }

  // Feed tabs
  get forYouTab() {
    return this.page.getByRole('button', { name: /for you/i });
  }

  get followingTab() {
    return this.page.getByRole('button', { name: /following/i });
  }

  // Compose area
  get composeButton() {
    return this.page.getByRole('button', { name: /what's happening/i });
  }

  get userAvatar() {
    return this.page.locator('img[alt*="avatar"]').first();
  }

  // Posts list
  get postsList() {
    return this.page.locator('main > div');
  }

  get posts() {
    return this.page.locator('article, [data-post-id]');
  }

  // Loading states
  get loadingIndicator() {
    return this.page.getByText(/connecting|loading/i).first();
  }

  get loadMoreButton() {
    return this.page.getByRole('button', { name: /load more/i });
  }

  // Empty states
  get emptyState() {
    return this.page.getByText(/no posts yet|feed is empty/i).first();
  }

  // Migration banner
  get migrationBanner() {
    return this.page.getByText(/migrate your profile/i);
  }

  get migrateButton() {
    return this.page.getByRole('button', { name: /migrate/i });
  }

  // Login prompt for non-authenticated users
  get loginPrompt() {
    return this.page.getByRole('link', { name: /login to share/i });
  }

  async goto() {
    await this.page.goto('/feed');
    await this.waitForPageLoad();
  }

  // Wait for feed to load
  async waitForFeedLoad(timeout: number = 60000) {
    // Wait for loading state to disappear
    await this.page.waitForSelector('text=/connecting|loading/i', { state: 'hidden', timeout }).catch(() => {});
    // Small delay for posts to render
    await this.page.waitForTimeout(1000);
  }

  // Switch to For You tab
  async switchToForYou() {
    await this.forYouTab.click();
    await this.waitForFeedLoad();
  }

  // Switch to Following tab
  async switchToFollowing() {
    await this.followingTab.click();
    await this.waitForFeedLoad();
  }

  // Open compose modal
  async openCompose() {
    await this.composeButton.click();
    await this.page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  }

  // Refresh feed
  async refreshFeed() {
    await this.refreshButton.click();
    await this.waitForFeedLoad();
  }

  // Get post count
  async getPostCount(): Promise<number> {
    // Wait a moment for posts to render
    await this.page.waitForTimeout(500);
    return await this.posts.count();
  }

  // Check if feed has posts
  async hasPosts(): Promise<boolean> {
    const count = await this.getPostCount();
    return count > 0;
  }

  // Load more posts
  async loadMore() {
    const button = this.loadMoreButton;
    if (await button.isVisible()) {
      await button.click();
      await this.page.waitForTimeout(2000);
    }
  }

  // Get post by index
  async getPostByIndex(index: number): Promise<Locator> {
    return this.posts.nth(index);
  }

  // Click on a post to view details
  async clickPost(index: number = 0) {
    const post = await this.getPostByIndex(index);
    await post.click();
    await this.page.waitForURL(/\/post/);
  }

  // Check if active tab is For You
  async isForYouActive(): Promise<boolean> {
    const classes = await this.forYouTab.getAttribute('class');
    return classes?.includes('text-gray-900') || classes?.includes('text-white') || false;
  }

  // Check if active tab is Following
  async isFollowingActive(): Promise<boolean> {
    const classes = await this.followingTab.getAttribute('class');
    return classes?.includes('text-gray-900') || classes?.includes('text-white') || false;
  }
}
