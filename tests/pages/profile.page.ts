import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class ProfilePage extends BasePage {
  // Profile header
  get displayName() {
    return this.page.locator('h1, h2').first();
  }

  get username() {
    return this.page.locator('span, p').filter({ hasText: /@|\.dash/ }).first();
  }

  get bio() {
    return this.page.locator('[data-bio], p').filter({ hasNotText: /@|\.dash|followers|following/ }).first();
  }

  get avatar() {
    return this.page.locator('img[alt*="avatar"], [data-avatar]').first();
  }

  // Stats
  get postCount() {
    return this.page.locator('span, div').filter({ hasText: /posts?$/i }).first();
  }

  get followersCount() {
    return this.page.getByRole('link', { name: /followers/i }).first();
  }

  get followingCount() {
    return this.page.getByRole('link', { name: /following/i }).first();
  }

  // Action buttons
  get editProfileButton() {
    return this.page.getByRole('button', { name: /edit profile/i });
  }

  get followButton() {
    return this.page.getByRole('button', { name: /^follow$/i });
  }

  get unfollowButton() {
    return this.page.getByRole('button', { name: /following|unfollow/i });
  }

  get settingsButton() {
    return this.page.getByRole('link', { name: /settings/i });
  }

  get shareButton() {
    return this.page.getByRole('button', { name: /share/i });
  }

  get backButton() {
    return this.page.getByRole('button', { name: /back/i });
  }

  // Profile info
  get location() {
    return this.page.locator('span, p').filter({ has: this.page.locator('[class*="MapPin"]') });
  }

  get website() {
    return this.page.locator('a[href^="http"]').first();
  }

  // User posts section
  get postsSection() {
    return this.page.locator('section, div').filter({ has: this.page.locator('article') });
  }

  get posts() {
    return this.page.locator('article');
  }

  // Empty state
  get noPosts() {
    return this.page.getByText(/no posts yet/i);
  }

  // Blocked user notice
  get blockedNotice() {
    return this.page.getByText(/blocked/i);
  }

  // Migration banner
  get migrationBanner() {
    return this.page.getByText(/migrate/i);
  }

  async goto(userId?: string) {
    if (userId) {
      await this.page.goto(`/user?id=${userId}`);
    } else {
      await this.page.goto('/profile');
    }
    await this.waitForPageLoad();
  }

  // Wait for profile to load
  async waitForProfileLoad(timeout: number = 30000) {
    await this.page.waitForLoadState('networkidle', { timeout });
  }

  // Follow user
  async follow() {
    await this.followButton.click();
    await this.page.waitForTimeout(2000);
  }

  // Unfollow user
  async unfollow() {
    await this.unfollowButton.click();
    await this.page.waitForTimeout(2000);
  }

  // Check if following
  async isFollowing(): Promise<boolean> {
    return await this.unfollowButton.isVisible().catch(() => false);
  }

  // Edit profile (opens create/edit form)
  async editProfile() {
    await this.editProfileButton.click();
    await this.page.waitForURL(/\/profile\/create/);
  }

  // Navigate to followers
  async viewFollowers() {
    await this.followersCount.click();
    await this.page.waitForURL(/\/followers/);
  }

  // Navigate to following
  async viewFollowing() {
    await this.followingCount.click();
    await this.page.waitForURL(/\/following/);
  }

  // Share profile
  async shareProfile() {
    await this.shareButton.click();
    await this.page.waitForTimeout(500);
  }

  // Get display name text
  async getDisplayName(): Promise<string> {
    return await this.displayName.textContent() || '';
  }

  // Get bio text
  async getBio(): Promise<string> {
    return await this.bio.textContent() || '';
  }

  // Get followers count
  async getFollowersCount(): Promise<number> {
    const text = await this.followersCount.textContent();
    const match = text?.match(/(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }

  // Get following count
  async getFollowingCount(): Promise<number> {
    const text = await this.followingCount.textContent();
    const match = text?.match(/(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }
}
