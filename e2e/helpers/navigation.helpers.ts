import { Page, expect } from '@playwright/test';

/**
 * Navigate to the home/feed page
 */
export async function goToHome(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to settings page, optionally to a specific section
 */
export async function goToSettings(page: Page, section?: string): Promise<void> {
  const url = section ? `/settings?section=${section}` : '/settings';
  await page.goto(url);
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to private feed settings
 */
export async function goToPrivateFeedSettings(page: Page): Promise<void> {
  await goToSettings(page, 'privateFeed');
}

/**
 * Navigate to a user's profile by identity ID
 */
export async function goToProfile(page: Page, identityId: string): Promise<void> {
  await page.goto(`/user?id=${identityId}`);
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to a user's profile by username (DPNS name)
 */
export async function goToProfileByUsername(page: Page, username: string): Promise<void> {
  await page.goto(`/@${username}`);
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to notifications page
 */
export async function goToNotifications(page: Page): Promise<void> {
  await page.goto('/notifications');
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to search page
 */
export async function goToSearch(page: Page): Promise<void> {
  await page.goto('/explore');
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to a specific post
 */
export async function goToPost(page: Page, postId: string): Promise<void> {
  await page.goto(`/post/${postId}`);
  await page.waitForLoadState('networkidle');
}

/**
 * Open the compose modal
 */
export async function openComposeModal(page: Page): Promise<void> {
  // Look for the compose button (usually a floating action button or in the header)
  const composeBtn = page.locator('button:has-text("Post")').or(
    page.locator('button:has-text("Compose")')
  ).or(page.locator('[aria-label="Compose"]'))
    .or(page.locator('button').filter({ has: page.locator('svg') }).first());

  // Try the new post button in sidebar or header
  const newPostBtn = page.locator('a[href*="compose"]').or(
    page.locator('button').filter({ hasText: /new post/i })
  );

  if (await newPostBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await newPostBtn.click();
  } else {
    // Click on compose in navigation or FAB
    await composeBtn.first().click();
  }

  // Wait for modal to appear
  await expect(page.locator('[role="dialog"]').or(page.locator('.compose-modal'))).toBeVisible({
    timeout: 5000,
  });
}

/**
 * Close any open modal
 */
export async function closeModal(page: Page): Promise<void> {
  const closeBtn = page.locator('[role="dialog"] button[aria-label="Close"]').or(
    page.locator('[role="dialog"] button:has-text("Cancel")')
  ).or(page.locator('[role="dialog"] button:has-text("Close")'));

  if (await closeBtn.isVisible()) {
    await closeBtn.click();
  } else {
    // Press escape to close modal
    await page.keyboard.press('Escape');
  }

  // Wait for modal to close
  await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 5000 });
}

/**
 * Wait for a toast notification
 */
export async function waitForToast(page: Page, text?: string): Promise<void> {
  const toastSelector = '[role="alert"]';

  if (text) {
    await expect(page.locator(toastSelector).filter({ hasText: text })).toBeVisible({
      timeout: 30000,
    });
  } else {
    await expect(page.locator(toastSelector)).toBeVisible({ timeout: 30000 });
  }
}

/**
 * Wait for a toast to disappear
 */
export async function waitForToastToDisappear(page: Page): Promise<void> {
  await expect(page.locator('[role="alert"]')).not.toBeVisible({ timeout: 10000 });
}

/**
 * Check if on a specific page
 */
export async function isOnPage(page: Page, path: string): Promise<boolean> {
  const url = new URL(page.url());
  return url.pathname === path || url.pathname.startsWith(path);
}

/**
 * Wait for page navigation to complete
 */
export async function waitForNavigation(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}
