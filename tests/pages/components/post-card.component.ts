import { Page, Locator, expect } from '@playwright/test';

export class PostCardComponent {
  constructor(
    private page: Page,
    private container: Locator
  ) {}

  // Post content
  get content() {
    return this.container.locator('p, [data-post-content]').first();
  }

  // Author info
  get authorName() {
    return this.container.locator('span, a').filter({ hasText: /\w+/ }).first();
  }

  get authorUsername() {
    return this.container.locator('span, a').filter({ hasText: /@|user_/ }).first();
  }

  get authorAvatar() {
    return this.container.locator('img[alt*="avatar"], [data-avatar]').first();
  }

  // Timestamp
  get timestamp() {
    return this.container.locator('time, span').filter({ hasText: /ago|just now|yesterday/i }).first();
  }

  // Interaction buttons
  get replyButton() {
    return this.container.locator('button').filter({ has: this.page.locator('svg') }).nth(0);
  }

  get repostButton() {
    return this.container.locator('button').filter({ has: this.page.locator('svg') }).nth(1);
  }

  get likeButton() {
    return this.container.locator('button').filter({ has: this.page.locator('svg') }).nth(2);
  }

  get tipButton() {
    return this.container.locator('button').filter({ has: this.page.locator('svg') }).nth(3);
  }

  get bookmarkButton() {
    return this.container.locator('button').filter({ has: this.page.locator('svg') }).nth(4);
  }

  get shareButton() {
    return this.container.locator('button').filter({ has: this.page.locator('svg') }).nth(5);
  }

  // More options menu
  get moreOptionsButton() {
    return this.container.locator('button').filter({ has: this.page.locator('[class*="Ellipsis"]') });
  }

  // Interaction counts
  get likeCount() {
    return this.likeButton.locator('span').first();
  }

  get repostCount() {
    return this.repostButton.locator('span').first();
  }

  get replyCount() {
    return this.replyButton.locator('span').first();
  }

  // Actions
  async like() {
    await this.likeButton.click();
    await this.page.waitForTimeout(1000);
  }

  async repost() {
    await this.repostButton.click();
    await this.page.waitForTimeout(1000);
  }

  async reply() {
    await this.replyButton.click();
    await this.page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  }

  async bookmark() {
    await this.bookmarkButton.click();
    await this.page.waitForTimeout(500);
  }

  async share() {
    await this.shareButton.click();
    await this.page.waitForTimeout(500);
  }

  async tip() {
    await this.tipButton.click();
    await this.page.waitForTimeout(500);
  }

  // Navigate to post detail
  async viewDetail() {
    await this.content.click();
    await this.page.waitForURL(/\/post/);
  }

  // Navigate to author profile
  async viewAuthorProfile() {
    await this.authorAvatar.click();
    await this.page.waitForURL(/\/user|\/profile/);
  }

  // Get post text content
  async getContent(): Promise<string> {
    return await this.content.textContent() || '';
  }

  // Get author display name
  async getAuthorName(): Promise<string> {
    return await this.authorName.textContent() || '';
  }

  // Check if post is liked
  async isLiked(): Promise<boolean> {
    const fill = await this.likeButton.locator('svg').getAttribute('fill');
    return fill === 'currentColor' || fill?.includes('red') || false;
  }

  // Check if post is bookmarked
  async isBookmarked(): Promise<boolean> {
    const fill = await this.bookmarkButton.locator('svg').getAttribute('fill');
    return fill === 'currentColor' || false;
  }
}
