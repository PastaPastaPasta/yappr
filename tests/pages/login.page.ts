import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class LoginPage extends BasePage {
  // Identity input
  get identityInput() {
    return this.page.locator('#identityInput');
  }

  // Credential input (password or private key)
  get credentialInput() {
    return this.page.locator('#credential');
  }

  // Show/hide credential toggle
  get showCredentialToggle() {
    return this.page.locator('button').filter({ has: this.page.locator('svg') }).first();
  }

  // Remember me toggle
  get rememberMeToggle() {
    return this.page.getByRole('switch');
  }

  // Sign in button
  get signInButton() {
    return this.page.getByRole('button', { name: /sign in/i });
  }

  // Loading indicators
  get identityLoadingSpinner() {
    return this.identityInput.locator('~ div svg.animate-spin');
  }

  // Identity validation icons
  get identityValidIcon() {
    return this.page.locator('svg path[d="M5 13l4 4L19 7"]').first();
  }

  get identityInvalidIcon() {
    return this.page.locator('svg path[d="M6 18L18 6M6 6l12 12"]').first();
  }

  // Error messages
  get lookupError() {
    return this.page.locator('.text-red-600, .text-red-400').first();
  }

  get formError() {
    return this.page.locator('.bg-red-50, .bg-red-900\\/20').first();
  }

  // External links
  get faucetLink() {
    return this.page.getByRole('link', { name: /faucet/i });
  }

  get bridgeLink() {
    return this.page.getByRole('link', { name: /bridge/i });
  }

  // Password unlock modal
  get passwordUnlockModal() {
    return this.page.locator('[role="dialog"]');
  }

  async goto() {
    await this.page.goto('/login');
    await this.waitForPageLoad();
  }

  // Enter identity ID and wait for lookup
  async enterIdentity(identity: string) {
    await this.identityInput.fill(identity);
    // Wait for debounce and lookup
    await this.page.waitForTimeout(600);
    // Wait for loading to complete
    await this.page.waitForFunction(() => {
      const spinner = document.querySelector('svg.animate-spin');
      return !spinner || spinner.closest('#identityInput + div') === null;
    }, { timeout: 30000 });
  }

  // Enter credential (password or private key)
  async enterCredential(credential: string) {
    await this.credentialInput.fill(credential);
    // Wait for key validation if it's a key
    await this.page.waitForTimeout(400);
  }

  // Toggle remember me
  async toggleRememberMe() {
    await this.rememberMeToggle.click();
  }

  // Submit login form
  async submitLogin() {
    await this.signInButton.click();
  }

  // Full login flow
  async login(identity: string, credential: string, options?: { rememberMe?: boolean }) {
    await this.enterIdentity(identity);
    await this.waitForIdentityValidation();
    await this.enterCredential(credential);
    await this.waitForKeyValidation();

    if (options?.rememberMe === false) {
      // Toggle off if currently on
      const isOn = await this.rememberMeToggle.getAttribute('aria-checked');
      if (isOn === 'true') {
        await this.toggleRememberMe();
      }
    }

    await this.submitLogin();
  }

  // Wait for identity lookup to complete
  async waitForIdentityValidation(timeout: number = 30000) {
    await this.page.waitForTimeout(500);
    // Wait for either valid or invalid indicator
    await Promise.race([
      this.page.waitForSelector('svg path[d="M5 13l4 4L19 7"]', { timeout }),
      this.page.waitForSelector('.text-red-600', { timeout }),
    ]).catch(() => {});
  }

  // Wait for key validation to complete
  async waitForKeyValidation(timeout: number = 30000) {
    await this.page.waitForTimeout(400);
    // Wait for validation to complete
    await Promise.race([
      this.page.waitForSelector('svg path[d="M5 13l4 4L19 7"]', { timeout }),
      this.page.waitForSelector('svg path[d="M6 18L18 6M6 6l12 12"]', { timeout }),
    ]).catch(() => {});
  }

  // Check if identity is resolved successfully
  async isIdentityResolved(): Promise<boolean> {
    try {
      await this.identityValidIcon.waitFor({ state: 'visible', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  // Check if login button is enabled
  async isLoginEnabled(): Promise<boolean> {
    return !(await this.signInButton.isDisabled());
  }
}
