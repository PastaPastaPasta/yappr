import { test, expect } from '../../fixtures/test-fixtures';
import { LoginPage } from '../../pages/login.page';
import { FeedPage } from '../../pages/feed.page';
import { TEST_IDENTITY, getHighAuthKey } from '../../fixtures/test-identity';

test.describe('Authentication - Login', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any stored credentials
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test('should display login page correctly', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Verify page elements are visible
    await expect(page.getByText('Yappr')).toBeVisible();
    await expect(page.getByText('Sign in with your Dash Platform identity')).toBeVisible();
    await expect(loginPage.identityInput).toBeVisible();
    await expect(loginPage.credentialInput).toBeVisible();
    await expect(loginPage.signInButton).toBeVisible();
    await expect(loginPage.faucetLink).toBeVisible();
    await expect(loginPage.bridgeLink).toBeVisible();
  });

  test('should validate identity ID format', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Enter valid identity ID
    await loginPage.enterIdentity(TEST_IDENTITY.identityId);

    // Wait for validation
    await loginPage.waitForIdentityValidation();

    // Should show valid indicator
    const isResolved = await loginPage.isIdentityResolved();
    expect(isResolved).toBe(true);
  });

  test('should show error for invalid identity', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Enter invalid identity
    await loginPage.enterIdentity('invalid-identity-id-that-doesnt-exist');

    // Wait for validation
    await page.waitForTimeout(2000);

    // Should show error message
    const errorVisible = await loginPage.lookupError.isVisible().catch(() => false);
    expect(errorVisible).toBe(true);
  });

  test('should validate private key against identity', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Enter identity
    await loginPage.enterIdentity(TEST_IDENTITY.identityId);
    await loginPage.waitForIdentityValidation();

    // Enter correct private key
    await loginPage.enterCredential(getHighAuthKey());
    await loginPage.waitForKeyValidation();

    // Sign in button should be enabled
    const isEnabled = await loginPage.isLoginEnabled();
    expect(isEnabled).toBe(true);
  });

  test('should reject incorrect private key', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Enter identity
    await loginPage.enterIdentity(TEST_IDENTITY.identityId);
    await loginPage.waitForIdentityValidation();

    // Enter incorrect private key (valid WIF but wrong identity)
    await loginPage.enterCredential('cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy');
    await loginPage.waitForKeyValidation();

    // Sign in button should be disabled
    const isEnabled = await loginPage.isLoginEnabled();
    expect(isEnabled).toBe(false);
  });

  test('should successfully login with valid credentials', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Perform login
    await loginPage.login(TEST_IDENTITY.identityId, getHighAuthKey());

    // Wait for redirect to feed
    await page.waitForURL(/\/feed/, { timeout: 30000 });

    // Verify we're on the feed page
    const feedPage = new FeedPage(page);
    await expect(feedPage.homeTitle).toBeVisible({ timeout: 10000 });
  });

  test('should toggle remember me setting', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Check initial state
    const initialState = await loginPage.rememberMeToggle.getAttribute('aria-checked');

    // Toggle
    await loginPage.toggleRememberMe();

    // Verify state changed
    const newState = await loginPage.rememberMeToggle.getAttribute('aria-checked');
    expect(newState).not.toBe(initialState);
  });

  test('should toggle credential visibility', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Enter some credential
    await loginPage.enterIdentity(TEST_IDENTITY.identityId);
    await loginPage.waitForIdentityValidation();
    await loginPage.credentialInput.fill('test-credential');

    // Check initial type is password
    const initialType = await loginPage.credentialInput.getAttribute('type');
    expect(initialType).toBe('password');

    // Click show toggle
    await page.locator('button').filter({ has: page.locator('svg') }).nth(1).click();

    // Verify type changed to text
    const newType = await loginPage.credentialInput.getAttribute('type');
    expect(newType).toBe('text');
  });

  test('should redirect authenticated users from homepage to feed', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Login
    await loginPage.login(TEST_IDENTITY.identityId, getHighAuthKey());
    await page.waitForURL(/\/feed/, { timeout: 30000 });

    // Navigate to homepage
    await page.goto('/');

    // Should redirect to feed
    await page.waitForURL(/\/feed/, { timeout: 10000 });
  });
});

test.describe('Authentication - Logout', () => {
  test('should successfully logout', async ({ authenticatedPage }) => {
    const page = authenticatedPage;

    // Navigate to settings
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Click logout
    const logoutButton = page.getByRole('button', { name: /logout|sign out/i });
    if (await logoutButton.isVisible()) {
      await logoutButton.click();

      // Should redirect to login or home
      await page.waitForURL(/\/login|\/$/, { timeout: 10000 });
    }
  });
});
