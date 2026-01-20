import { Page, expect } from '@playwright/test';
import { goToPrivateFeedSettings, openComposeModal, waitForToast, goToProfile } from './navigation.helpers';

/**
 * Enable private feed for the current user
 * Requires being logged in and having an encryption key
 */
export async function enablePrivateFeed(page: Page, encryptionKey: string): Promise<void> {
  // Navigate to private feed settings
  await goToPrivateFeedSettings(page);

  // Look for the enable button
  const enableBtn = page.locator('button:has-text("Enable Private Feed")');

  // If private feed is already enabled, skip
  if (!(await enableBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    // Check if already enabled
    const alreadyEnabled = page.locator('text=Private feed is enabled').or(
      page.locator('text=Private Feed Dashboard')
    );
    if (await alreadyEnabled.isVisible({ timeout: 2000 }).catch(() => false)) {
      return; // Already enabled
    }
  }

  await enableBtn.click();

  // Wait for modal to appear
  const modal = page.locator('[role="dialog"]');
  await expect(modal).toBeVisible({ timeout: 10000 });

  // Enter encryption key
  const keyInput = modal.locator('input[type="password"]');
  await keyInput.fill(encryptionKey);

  // Click enable/confirm button in modal
  const confirmBtn = modal.locator('button:has-text("Enable")').or(
    modal.locator('button:has-text("Confirm")')
  );
  await confirmBtn.click();

  // Wait for success - this is a blockchain operation so give it time
  await waitForToast(page);

  // Verify private feed is now enabled
  await expect(page.locator('text=Private Feed Dashboard').or(
    page.locator('text=Private feed is enabled')
  )).toBeVisible({ timeout: 60000 });
}

/**
 * Create a private post
 */
export async function createPrivatePost(
  page: Page,
  content: string,
  options?: {
    teaser?: string;
    visibility?: 'private' | 'private-with-teaser';
  }
): Promise<string> {
  // Open compose modal
  await openComposeModal(page);

  const modal = page.locator('[role="dialog"]');

  // Select visibility
  const visibilityDropdown = modal.locator('[role="combobox"]').or(
    modal.locator('button').filter({ hasText: /public/i })
  );

  if (await visibilityDropdown.isVisible()) {
    await visibilityDropdown.click();

    // Select private option
    if (options?.visibility === 'private-with-teaser') {
      await page.locator('button:has-text("Private with Teaser")').or(
        page.locator('[role="option"]:has-text("Private with Teaser")')
      ).click();
    } else {
      await page.locator('button:has-text("Private")').first().or(
        page.locator('[role="option"]:has-text("Private")').first()
      ).click();
    }
  }

  // Fill in content
  const contentArea = modal.locator('textarea').first();
  await contentArea.fill(content);

  // Fill in teaser if provided
  if (options?.teaser) {
    const teaserArea = modal.locator('textarea[placeholder*="teaser" i]').or(
      modal.locator('textarea').nth(1)
    );
    if (await teaserArea.isVisible()) {
      await teaserArea.fill(options.teaser);
    }
  }

  // Click post button
  const postBtn = modal.locator('button:has-text("Post")');
  await postBtn.click();

  // Wait for success
  await waitForToast(page);

  // Return post ID if available (from URL or page content)
  // For now, return empty string as we may not have access to the post ID directly
  return '';
}

/**
 * Create a public post
 */
export async function createPublicPost(page: Page, content: string): Promise<string> {
  await openComposeModal(page);

  const modal = page.locator('[role="dialog"]');

  // Ensure public visibility (should be default)
  const contentArea = modal.locator('textarea').first();
  await contentArea.fill(content);

  const postBtn = modal.locator('button:has-text("Post")');
  await postBtn.click();

  await waitForToast(page);

  return '';
}

/**
 * Request access to a user's private feed
 */
export async function requestAccess(page: Page, ownerIdentityId: string): Promise<void> {
  // Navigate to owner's profile
  await goToProfile(page, ownerIdentityId);

  // Click request access button
  const requestBtn = page.locator('button:has-text("Request Access")');
  await expect(requestBtn).toBeVisible({ timeout: 10000 });
  await requestBtn.click();

  // Wait for confirmation
  await waitForToast(page);

  // Verify pending state
  await expect(page.locator('text=Pending').or(
    page.locator('text=Request Sent')
  )).toBeVisible({ timeout: 30000 });
}

/**
 * Approve a follower's access request
 */
export async function approveFollower(page: Page, followerIdentityId: string): Promise<void> {
  // Navigate to private feed settings
  await goToPrivateFeedSettings(page);

  // Find the follower in pending requests
  const pendingSection = page.locator('text=Pending Requests').locator('..');
  const followerRow = pendingSection.locator(`text=${followerIdentityId}`).or(
    page.locator(`[data-identity="${followerIdentityId}"]`)
  );

  // Click approve button
  const approveBtn = followerRow.locator('button:has-text("Approve")').or(
    page.locator(`button:has-text("Approve")`).first()
  );

  await approveBtn.click();

  // Wait for success
  await waitForToast(page);
}

/**
 * Revoke a follower's access
 */
export async function revokeFollower(page: Page, followerIdentityId: string): Promise<void> {
  // Navigate to private feed settings
  await goToPrivateFeedSettings(page);

  // Find the follower in approved list
  const followerRow = page.locator(`[data-identity="${followerIdentityId}"]`).or(
    page.locator('text=Approved').locator('..').locator(`text=${followerIdentityId}`)
  );

  // Click revoke button
  const revokeBtn = followerRow.locator('button:has-text("Revoke")').or(
    page.locator('button:has-text("Revoke")').first()
  );

  await revokeBtn.click();

  // Confirm if there's a confirmation dialog
  const confirmBtn = page.locator('[role="dialog"] button:has-text("Confirm")').or(
    page.locator('[role="dialog"] button:has-text("Revoke")')
  );
  if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirmBtn.click();
  }

  // Wait for success
  await waitForToast(page);
}

/**
 * Check if a post is decrypted (visible content)
 */
export async function isPostDecrypted(page: Page, postLocator: string | ReturnType<Page['locator']>): Promise<boolean> {
  const post = typeof postLocator === 'string' ? page.locator(postLocator) : postLocator;

  // A decrypted post should NOT show lock icon or encrypted placeholder
  const lockIcon = post.locator('[aria-label*="locked" i]').or(
    post.locator('svg').filter({ hasText: /lock/i })
  );
  const encryptedPlaceholder = post.locator('text=This content is encrypted').or(
    post.locator('text=Private content')
  );

  const hasLock = await lockIcon.isVisible({ timeout: 1000 }).catch(() => false);
  const hasPlaceholder = await encryptedPlaceholder.isVisible({ timeout: 1000 }).catch(() => false);

  return !hasLock && !hasPlaceholder;
}

/**
 * Check if a post is locked (encrypted, not accessible)
 */
export async function isPostLocked(page: Page, postLocator: string | ReturnType<Page['locator']>): Promise<boolean> {
  const post = typeof postLocator === 'string' ? page.locator(postLocator) : postLocator;

  // A locked post shows lock icon or encrypted placeholder
  const lockIcon = post.locator('[aria-label*="locked" i]').or(
    post.locator('svg').filter({ hasText: /lock/i })
  );
  const encryptedPlaceholder = post.locator('text=This content is encrypted').or(
    post.locator('text=Private content')
  );

  const hasLock = await lockIcon.isVisible({ timeout: 1000 }).catch(() => false);
  const hasPlaceholder = await encryptedPlaceholder.isVisible({ timeout: 1000 }).catch(() => false);

  return hasLock || hasPlaceholder;
}

/**
 * Get the current epoch from localStorage
 */
export async function getCurrentEpoch(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const epoch = localStorage.getItem('yappr:pf:current_epoch');
    return epoch ? parseInt(epoch, 10) : null;
  });
}

/**
 * Get private feed state from localStorage
 */
export async function getPrivateFeedState(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const state = localStorage.getItem('yappr:pf:state');
    return state ? JSON.parse(state) : null;
  });
}

/**
 * Wait for private feed to be enabled
 */
export async function waitForPrivateFeedEnabled(page: Page): Promise<void> {
  await expect(async () => {
    const state = await getPrivateFeedState(page);
    if (!state || !state.enabled) {
      throw new Error('Private feed not yet enabled');
    }
  }).toPass({ timeout: 60000, intervals: [1000, 2000, 5000] });
}

/**
 * Enter encryption key in settings (for accessing private feed as owner)
 */
export async function enterEncryptionKeyInSettings(page: Page, encryptionKey: string): Promise<void> {
  await goToPrivateFeedSettings(page);

  const enterKeyBtn = page.locator('button:has-text("Enter Encryption Key")').or(
    page.locator('button:has-text("Add Encryption Key")')
  );

  if (await enterKeyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await enterKeyBtn.click();

    const modal = page.locator('[role="dialog"]');
    await expect(modal).toBeVisible();

    const keyInput = modal.locator('input[type="password"]');
    await keyInput.fill(encryptionKey);

    const confirmBtn = modal.locator('button:has-text("Confirm")').or(
      modal.locator('button:has-text("Enter")')
    );
    await confirmBtn.click();

    await waitForToast(page);
  }
}
