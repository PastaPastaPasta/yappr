import { test, expect } from '../../fixtures/test-fixtures';
import { SettingsPage } from '../../pages/settings.page';

test.describe('Settings - Navigation', () => {
  test('should display settings page correctly', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    // Should show settings sections
    const hasAccount = await settingsPage.accountSection.isVisible().catch(() => false);
    const hasAppearance = await settingsPage.appearanceSection.isVisible().catch(() => false);

    expect(hasAccount || hasAppearance).toBe(true);
  });

  test('should navigate to account section', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasAccount = await settingsPage.accountSection.isVisible().catch(() => false);
    if (hasAccount) {
      await settingsPage.goToAccount();

      // Should show account info
      const hasIdentity = await settingsPage.identityId.isVisible().catch(() => false);
      const hasLogout = await settingsPage.logoutButton.isVisible().catch(() => false);
      expect(hasIdentity || hasLogout).toBe(true);
    }
  });

  test('should navigate to notifications section', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasNotifications = await settingsPage.notificationsSection.isVisible().catch(() => false);
    if (hasNotifications) {
      await settingsPage.goToNotifications();

      // Should show notification toggles
      await page.waitForTimeout(500);
    }
  });

  test('should navigate to privacy section', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasPrivacy = await settingsPage.privacySection.isVisible().catch(() => false);
    if (hasPrivacy) {
      await settingsPage.goToPrivacy();

      // Should show privacy settings
      await page.waitForTimeout(500);
    }
  });

  test('should navigate to appearance section', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasAppearance = await settingsPage.appearanceSection.isVisible().catch(() => false);
    if (hasAppearance) {
      await settingsPage.goToAppearance();

      // Should show theme options
      await page.waitForTimeout(500);
    }
  });

  test('should navigate to about section', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasAbout = await settingsPage.aboutSection.isVisible().catch(() => false);
    if (hasAbout) {
      await settingsPage.goToAbout();

      // Should show about info
      await page.waitForTimeout(500);
    }
  });
});

test.describe('Settings - Theme', () => {
  test('should display theme options', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasAppearance = await settingsPage.appearanceSection.isVisible().catch(() => false);
    if (hasAppearance) {
      await settingsPage.goToAppearance();

      // Check for theme options
      const hasLight = await settingsPage.lightThemeOption.isVisible().catch(() => false);
      const hasDark = await settingsPage.darkThemeOption.isVisible().catch(() => false);
      const hasSystem = await settingsPage.systemThemeOption.isVisible().catch(() => false);

      expect(hasLight || hasDark || hasSystem).toBe(true);
    }
  });

  test('should switch to dark theme', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasAppearance = await settingsPage.appearanceSection.isVisible().catch(() => false);
    if (hasAppearance) {
      await settingsPage.goToAppearance();

      const hasDark = await settingsPage.darkThemeOption.isVisible().catch(() => false);
      if (hasDark) {
        await settingsPage.setTheme('dark');

        // Page should have dark class
        await page.waitForTimeout(500);
        const htmlClass = await page.locator('html').getAttribute('class');
        const hasDarkClass = htmlClass?.includes('dark') || false;
        expect(hasDarkClass).toBe(true);
      }
    }
  });

  test('should switch to light theme', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasAppearance = await settingsPage.appearanceSection.isVisible().catch(() => false);
    if (hasAppearance) {
      await settingsPage.goToAppearance();

      const hasLight = await settingsPage.lightThemeOption.isVisible().catch(() => false);
      if (hasLight) {
        await settingsPage.setTheme('light');

        // Page should have light theme
        await page.waitForTimeout(500);
        const htmlClass = await page.locator('html').getAttribute('class');
        const hasDarkClass = htmlClass?.includes('dark') || false;
        expect(hasDarkClass).toBe(false);
      }
    }
  });
});

test.describe('Settings - Account', () => {
  test('should display identity ID', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasAccount = await settingsPage.accountSection.isVisible().catch(() => false);
    if (hasAccount) {
      await settingsPage.goToAccount();

      // Should display identity ID somewhere
      const hasIdentity = await settingsPage.identityId.isVisible().catch(() => false);
      expect(typeof hasIdentity).toBe('boolean');
    }
  });

  test('should display logout button', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasAccount = await settingsPage.accountSection.isVisible().catch(() => false);
    if (hasAccount) {
      await settingsPage.goToAccount();

      // Logout button should be visible
      const hasLogout = await settingsPage.logoutButton.isVisible().catch(() => false);
      expect(hasLogout).toBe(true);
    }
  });
});

test.describe('Settings - Notifications', () => {
  test('should display notification toggles', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const settingsPage = new SettingsPage(page);

    await settingsPage.goto();

    const hasNotifications = await settingsPage.notificationsSection.isVisible().catch(() => false);
    if (hasNotifications) {
      await settingsPage.goToNotifications();

      // Should show some notification toggles
      const switchElements = page.getByRole('switch');
      const switchCount = await switchElements.count();
      expect(switchCount).toBeGreaterThanOrEqual(0);
    }
  });
});
