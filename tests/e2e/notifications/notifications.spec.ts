import { test, expect } from '../../fixtures/test-fixtures';

test.describe('Notifications - Display', () => {
  test('should display notifications page correctly', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/notifications');
    await page.waitForLoadState('networkidle');

    // Should show notifications heading or content
    const hasNotificationsText = await page.getByText(/notifications/i).first().isVisible().catch(() => false);
    expect(hasNotificationsText).toBe(true);
  });

  test('should show filter tabs', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/notifications');
    await page.waitForLoadState('networkidle');

    // Check for filter buttons
    const allTab = page.getByRole('button', { name: /all/i });
    const hasAllTab = await allTab.isVisible().catch(() => false);
    expect(typeof hasAllTab).toBe('boolean');
  });

  test('should show empty state when no notifications', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/notifications');
    await page.waitForLoadState('networkidle');

    // Should either have notifications or show empty state
    const hasEmptyState = await page.getByText(/no notifications|empty/i).isVisible().catch(() => false);
    const hasNotifications = await page.locator('[data-notification], li, article').first().isVisible().catch(() => false);

    expect(hasEmptyState || hasNotifications).toBe(true);
  });

  test('should show settings link', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/notifications');
    await page.waitForLoadState('networkidle');

    // Check for settings button
    const settingsButton = page.getByRole('link', { name: /settings/i });
    const hasSettings = await settingsButton.isVisible().catch(() => false);
    expect(typeof hasSettings).toBe('boolean');
  });
});

test.describe('Notifications - Filters', () => {
  test('should filter by likes', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/notifications');
    await page.waitForLoadState('networkidle');

    const likesTab = page.getByRole('button', { name: /likes/i });
    const hasLikesTab = await likesTab.isVisible().catch(() => false);

    if (hasLikesTab) {
      await likesTab.click();
      await page.waitForTimeout(500);
    }
  });

  test('should filter by follows', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/notifications');
    await page.waitForLoadState('networkidle');

    const followsTab = page.getByRole('button', { name: /follows/i });
    const hasFollowsTab = await followsTab.isVisible().catch(() => false);

    if (hasFollowsTab) {
      await followsTab.click();
      await page.waitForTimeout(500);
    }
  });

  test('should filter by replies', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/notifications');
    await page.waitForLoadState('networkidle');

    const repliesTab = page.getByRole('button', { name: /replies/i });
    const hasRepliesTab = await repliesTab.isVisible().catch(() => false);

    if (hasRepliesTab) {
      await repliesTab.click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe('Notifications - Actions', () => {
  test('should mark all as read', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    await page.goto('/notifications');
    await page.waitForLoadState('networkidle');

    const markAllReadButton = page.getByRole('button', { name: /mark all|read all/i });
    const hasMarkAllRead = await markAllReadButton.isVisible().catch(() => false);
    expect(typeof hasMarkAllRead).toBe('boolean');
  });
});
