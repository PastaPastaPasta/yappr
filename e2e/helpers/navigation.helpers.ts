import { Page, expect } from '@playwright/test';

/**
 * Navigate to the home/feed page and wait for it to fully load
 */
export async function goToHome(page: Page): Promise<void> {
  // Navigate to /feed explicitly (/ may redirect to other places)
  await page.goto('/feed');
  await page.waitForLoadState('domcontentloaded');

  // Wait for feed page to be interactive - look for the Home header first
  // This appears before the feed content loads
  const homeHeader = page.getByRole('heading', { name: 'Home' });
  await expect(homeHeader).toBeVisible({ timeout: 30000 });

  // Wait for the compose area to be ready (indicates user is logged in and feed is loading)
  // The "What's happening?" button indicates the page is ready for interaction
  const composeArea = page.getByRole('button', { name: /what.?s happening/i });
  await expect(composeArea).toBeVisible({ timeout: 60000 });

  // Give a moment for any dynamic content to settle
  await page.waitForTimeout(2000);
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
  // Primary: Click the "What's happening?" button in the feed composer area
  const whatsHappeningBtn = page.locator('button:has-text("What\'s happening")');

  // Fallback: Look for compose buttons in sidebar or other locations
  const sidebarPost = page.locator('button:has-text("Post")');
  const composeBtn = page.locator('button:has-text("Compose")');
  const composeAriaLabel = page.locator('[aria-label="Compose"]');

  // Try the "What's happening?" button first (most reliable on feed page)
  if (await whatsHappeningBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await whatsHappeningBtn.click();
  } else if (await sidebarPost.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sidebarPost.click();
  } else if (await composeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await composeBtn.click();
  } else if (await composeAriaLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
    await composeAriaLabel.click();
  } else {
    throw new Error('Could not find compose button to open modal');
  }

  // Wait for modal to appear
  await expect(page.locator('[role="dialog"]')).toBeVisible({
    timeout: 10000,
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
