import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class SettingsPage extends BasePage {
  // Navigation tabs/sections
  get accountSection() {
    return this.page.getByRole('button', { name: /account/i });
  }

  get notificationsSection() {
    return this.page.getByRole('button', { name: /notifications/i });
  }

  get privacySection() {
    return this.page.getByRole('button', { name: /privacy|security/i });
  }

  get appearanceSection() {
    return this.page.getByRole('button', { name: /appearance|theme/i });
  }

  get aboutSection() {
    return this.page.getByRole('button', { name: /about/i });
  }

  // Account section elements
  get identityId() {
    return this.page.locator('code, span').filter({ hasText: /^[1-9A-HJ-NP-Za-km-z]{42,46}$/ }).first();
  }

  get dashBalance() {
    return this.page.locator('span, p').filter({ hasText: /dash|credits/i }).first();
  }

  get logoutButton() {
    return this.page.getByRole('button', { name: /logout|sign out/i });
  }

  get deleteAccountButton() {
    return this.page.getByRole('button', { name: /delete account/i });
  }

  // Notification toggles
  get likesNotificationToggle() {
    return this.page.getByRole('switch', { name: /likes/i });
  }

  get repostsNotificationToggle() {
    return this.page.getByRole('switch', { name: /reposts/i });
  }

  get repliesNotificationToggle() {
    return this.page.getByRole('switch', { name: /replies/i });
  }

  get followsNotificationToggle() {
    return this.page.getByRole('switch', { name: /follows/i });
  }

  get mentionsNotificationToggle() {
    return this.page.getByRole('switch', { name: /mentions/i });
  }

  get messagesNotificationToggle() {
    return this.page.getByRole('switch', { name: /messages/i });
  }

  // Privacy section elements
  get publicProfileToggle() {
    return this.page.getByRole('switch', { name: /public profile/i });
  }

  get activityStatusToggle() {
    return this.page.getByRole('switch', { name: /activity status/i });
  }

  get dmPrivacySelect() {
    return this.page.locator('select, [role="listbox"]').filter({ has: this.page.locator('text=/everyone|followers|no one/i') });
  }

  get viewBlockedButton() {
    return this.page.getByRole('button', { name: /view blocked|blocked users/i });
  }

  get keyBackupButton() {
    return this.page.getByRole('button', { name: /backup|key backup/i });
  }

  // Appearance section elements
  get lightThemeOption() {
    return this.page.getByRole('radio', { name: /light/i });
  }

  get darkThemeOption() {
    return this.page.getByRole('radio', { name: /dark/i });
  }

  get systemThemeOption() {
    return this.page.getByRole('radio', { name: /system/i });
  }

  // About section elements
  get versionInfo() {
    return this.page.locator('span, p').filter({ hasText: /version|v\d/i });
  }

  get contractLink() {
    return this.page.getByRole('link', { name: /contract/i });
  }

  get githubLink() {
    return this.page.getByRole('link', { name: /github/i });
  }

  async goto() {
    await this.page.goto('/settings');
    await this.waitForPageLoad();
  }

  // Navigate to account section
  async goToAccount() {
    await this.accountSection.click();
    await this.page.waitForTimeout(300);
  }

  // Navigate to notifications section
  async goToNotifications() {
    await this.notificationsSection.click();
    await this.page.waitForTimeout(300);
  }

  // Navigate to privacy section
  async goToPrivacy() {
    await this.privacySection.click();
    await this.page.waitForTimeout(300);
  }

  // Navigate to appearance section
  async goToAppearance() {
    await this.appearanceSection.click();
    await this.page.waitForTimeout(300);
  }

  // Navigate to about section
  async goToAbout() {
    await this.aboutSection.click();
    await this.page.waitForTimeout(300);
  }

  // Logout
  async logout() {
    await this.logoutButton.click();
    await this.page.waitForURL(/\/login|\//);
  }

  // Set theme
  async setTheme(theme: 'light' | 'dark' | 'system') {
    switch (theme) {
      case 'light':
        await this.lightThemeOption.click();
        break;
      case 'dark':
        await this.darkThemeOption.click();
        break;
      case 'system':
        await this.systemThemeOption.click();
        break;
    }
    await this.page.waitForTimeout(300);
  }

  // Toggle notification setting
  async toggleNotification(type: 'likes' | 'reposts' | 'replies' | 'follows' | 'mentions' | 'messages') {
    const toggleMap = {
      likes: this.likesNotificationToggle,
      reposts: this.repostsNotificationToggle,
      replies: this.repliesNotificationToggle,
      follows: this.followsNotificationToggle,
      mentions: this.mentionsNotificationToggle,
      messages: this.messagesNotificationToggle,
    };
    await toggleMap[type].click();
    await this.page.waitForTimeout(300);
  }

  // View blocked users
  async viewBlockedUsers() {
    await this.viewBlockedButton.click();
    await this.page.waitForTimeout(500);
  }
}
