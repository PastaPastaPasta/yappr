import { Page, Locator, expect } from '@playwright/test';

export abstract class BasePage {
  constructor(protected page: Page) {}

  // Common navigation elements
  get navigation() {
    return this.page.locator('nav, [role="navigation"]').first();
  }

  get homeLink() {
    return this.page.getByRole('link', { name: /home/i }).first();
  }

  get exploreLink() {
    return this.page.getByRole('link', { name: /explore|search/i }).first();
  }

  get profileLink() {
    return this.page.getByRole('link', { name: /profile/i }).first();
  }

  get messagesLink() {
    return this.page.getByRole('link', { name: /messages/i }).first();
  }

  get notificationsLink() {
    return this.page.getByRole('link', { name: /notifications/i }).first();
  }

  get bookmarksLink() {
    return this.page.getByRole('link', { name: /bookmarks/i }).first();
  }

  get settingsLink() {
    return this.page.getByRole('link', { name: /settings/i }).first();
  }

  // Common actions
  async waitForPageLoad(timeout: number = 30000) {
    await this.page.waitForLoadState('domcontentloaded', { timeout });
  }

  async waitForNetworkIdle(timeout: number = 30000) {
    await this.page.waitForLoadState('networkidle', { timeout });
  }

  async navigateToHome() {
    await this.homeLink.click();
    await this.waitForPageLoad();
  }

  async navigateToExplore() {
    await this.exploreLink.click();
    await this.waitForPageLoad();
  }

  async navigateToProfile() {
    await this.profileLink.click();
    await this.waitForPageLoad();
  }

  async navigateToMessages() {
    await this.messagesLink.click();
    await this.waitForPageLoad();
  }

  async navigateToNotifications() {
    await this.notificationsLink.click();
    await this.waitForPageLoad();
  }

  async navigateToBookmarks() {
    await this.bookmarksLink.click();
    await this.waitForPageLoad();
  }

  async navigateToSettings() {
    await this.settingsLink.click();
    await this.waitForPageLoad();
  }

  // Toast notifications
  async waitForToast(text?: string | RegExp) {
    const toast = this.page.locator('[role="status"], .toast, [class*="toast"]').first();
    await expect(toast).toBeVisible({ timeout: 10000 });
    if (text) {
      await expect(toast).toContainText(text);
    }
  }

  // Abstract method for page-specific navigation
  abstract goto(): Promise<void>;
}
