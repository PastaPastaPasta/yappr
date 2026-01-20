import { Page, expect, Locator } from '@playwright/test';

/**
 * Assert that a toast notification appeared with specific text
 */
export async function assertToastAppeared(page: Page, text?: string): Promise<void> {
  const toast = page.locator('[role="alert"]');

  if (text) {
    await expect(toast.filter({ hasText: text })).toBeVisible({ timeout: 30000 });
  } else {
    await expect(toast).toBeVisible({ timeout: 30000 });
  }
}

/**
 * Assert that a success toast appeared
 */
export async function assertSuccessToast(page: Page): Promise<void> {
  await expect(
    page.locator('[role="alert"]').filter({ hasText: /success/i }).or(
      page.locator('[role="alert"].success')
    )
  ).toBeVisible({ timeout: 30000 });
}

/**
 * Assert that an error toast appeared
 */
export async function assertErrorToast(page: Page, errorText?: string): Promise<void> {
  const errorToast = page.locator('[role="alert"]').filter({ hasText: /error/i }).or(
    page.locator('[role="alert"].error')
  );

  if (errorText) {
    await expect(errorToast.filter({ hasText: errorText })).toBeVisible({ timeout: 30000 });
  } else {
    await expect(errorToast).toBeVisible({ timeout: 30000 });
  }
}

/**
 * Assert that private feed is enabled for current user
 */
export async function assertPrivateFeedEnabled(page: Page): Promise<void> {
  // Check UI indicators
  const enabledIndicator = page.locator('text=Private feed is enabled').or(
    page.locator('text=Private Feed Dashboard')
  ).or(page.locator('[data-testid="private-feed-enabled"]'));

  await expect(enabledIndicator).toBeVisible({ timeout: 10000 });
}

/**
 * Assert that private feed is NOT enabled for current user
 */
export async function assertPrivateFeedNotEnabled(page: Page): Promise<void> {
  const enableBtn = page.locator('button:has-text("Enable Private Feed")');
  await expect(enableBtn).toBeVisible({ timeout: 10000 });
}

/**
 * Assert that a post shows encrypted/locked state
 */
export async function assertPostLocked(post: Locator): Promise<void> {
  const lockIndicator = post.locator('[aria-label*="locked" i]').or(
    post.locator('text=This content is encrypted')
  ).or(post.locator('text=Private content'));

  await expect(lockIndicator).toBeVisible({ timeout: 10000 });
}

/**
 * Assert that a post shows decrypted content
 */
export async function assertPostDecrypted(post: Locator, expectedContent?: string): Promise<void> {
  // Should NOT show lock indicator
  const lockIndicator = post.locator('[aria-label*="locked" i]').or(
    post.locator('text=This content is encrypted')
  );
  await expect(lockIndicator).not.toBeVisible({ timeout: 5000 });

  // If content is provided, verify it's visible
  if (expectedContent) {
    await expect(post.locator(`text=${expectedContent}`)).toBeVisible();
  }
}

/**
 * Assert that user has pending access request
 */
export async function assertAccessPending(page: Page): Promise<void> {
  await expect(
    page.locator('text=Pending').or(page.locator('text=Request Sent'))
  ).toBeVisible({ timeout: 10000 });
}

/**
 * Assert that user has approved access
 */
export async function assertAccessApproved(page: Page): Promise<void> {
  await expect(
    page.locator('text=Approved').or(
      page.locator('text=Access Granted')
    ).or(page.locator('[data-testid="access-approved"]'))
  ).toBeVisible({ timeout: 10000 });
}

/**
 * Assert that user's access was revoked
 */
export async function assertAccessRevoked(page: Page): Promise<void> {
  await expect(
    page.locator('text=Revoked').or(page.locator('text=Access Revoked'))
  ).toBeVisible({ timeout: 10000 });
}

/**
 * Assert that a modal is visible
 */
export async function assertModalVisible(page: Page): Promise<void> {
  await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
}

/**
 * Assert that no modal is visible
 */
export async function assertNoModal(page: Page): Promise<void> {
  await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 5000 });
}

/**
 * Assert compose modal shows private option
 */
export async function assertPrivateOptionAvailable(page: Page): Promise<void> {
  // The visibility dropdown should contain private options
  const privateOption = page.locator('button:has-text("Private")').or(
    page.locator('[role="option"]:has-text("Private")')
  );
  await expect(privateOption).toBeVisible({ timeout: 5000 });
}

/**
 * Assert that user is on a specific page
 */
export async function assertOnPage(page: Page, expectedPath: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(expectedPath));
}

/**
 * Assert that user is logged in
 */
export async function assertLoggedIn(page: Page): Promise<void> {
  // Should not be on login page and should see navigation
  await expect(page).not.toHaveURL('/login');

  // Look for authenticated UI elements
  const authenticatedIndicator = page.locator('a[href="/"]').or(
    page.locator('[data-testid="user-menu"]')
  ).or(page.locator('nav'));

  await expect(authenticatedIndicator.first()).toBeVisible({ timeout: 10000 });
}

/**
 * Assert localStorage contains expected key
 */
export async function assertLocalStorageKey(page: Page, key: string, expectedValue?: string): Promise<void> {
  const value = await page.evaluate((k) => localStorage.getItem(k), key);

  expect(value).not.toBeNull();

  if (expectedValue !== undefined) {
    expect(value).toBe(expectedValue);
  }
}

/**
 * Assert localStorage does not contain key
 */
export async function assertNoLocalStorageKey(page: Page, key: string): Promise<void> {
  const value = await page.evaluate((k) => localStorage.getItem(k), key);
  expect(value).toBeNull();
}

/**
 * Assert element count
 */
export async function assertElementCount(locator: Locator, count: number): Promise<void> {
  await expect(locator).toHaveCount(count);
}

/**
 * Assert loading state is complete
 */
export async function assertNotLoading(page: Page): Promise<void> {
  const loadingIndicator = page.locator('[data-testid="loading"]').or(
    page.locator('.loading')
  ).or(page.locator('[aria-busy="true"]'));

  await expect(loadingIndicator).not.toBeVisible({ timeout: 30000 });
}
