import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class ProfileCreatePage extends BasePage {
  // Form fields
  get displayNameInput() {
    return this.page.getByLabel(/display name/i);
  }

  get bioInput() {
    return this.page.getByLabel(/bio/i);
  }

  get pronounsInput() {
    return this.page.getByLabel(/pronouns/i);
  }

  get locationInput() {
    return this.page.getByLabel(/location/i);
  }

  get websiteInput() {
    return this.page.getByLabel(/website/i);
  }

  // Avatar section
  get avatarPreview() {
    return this.page.locator('img[alt*="avatar"], [data-avatar]').first();
  }

  get editAvatarButton() {
    return this.page.getByRole('button', { name: /edit avatar|change avatar/i });
  }

  get randomizeAvatarButton() {
    return this.page.getByRole('button', { name: /randomize|random/i });
  }

  // Payment addresses
  get addPaymentButton() {
    return this.page.getByRole('button', { name: /add.*payment|add.*address/i });
  }

  get paymentInputs() {
    return this.page.locator('input[placeholder*="address"], input[name*="payment"]');
  }

  // Social links
  get addSocialButton() {
    return this.page.getByRole('button', { name: /add.*social|add.*link/i });
  }

  get socialInputs() {
    return this.page.locator('input[placeholder*="handle"], input[name*="social"]');
  }

  // NSFW toggle
  get nsfwToggle() {
    return this.page.getByRole('switch').filter({ hasText: /nsfw|adult/i });
  }

  // Private key input (if needed)
  get privateKeyInput() {
    return this.page.getByLabel(/private key/i);
  }

  // Submit button
  get submitButton() {
    return this.page.getByRole('button', { name: /create|save|submit/i });
  }

  // Cancel button
  get cancelButton() {
    return this.page.getByRole('button', { name: /cancel/i });
  }

  // Character counters
  get bioCounter() {
    return this.page.locator('span').filter({ hasText: /\/200/ });
  }

  // Error messages
  get errorMessage() {
    return this.page.locator('.text-red-600, .text-red-400, .bg-red-50').first();
  }

  // Success message
  get successMessage() {
    return this.page.locator('.text-green-600, .text-green-400, .bg-green-50').first();
  }

  async goto() {
    await this.page.goto('/profile/create');
    await this.waitForPageLoad();
  }

  // Fill display name
  async fillDisplayName(name: string) {
    await this.displayNameInput.fill(name);
  }

  // Fill bio
  async fillBio(bio: string) {
    await this.bioInput.fill(bio);
  }

  // Fill pronouns
  async fillPronouns(pronouns: string) {
    await this.pronounsInput.fill(pronouns);
  }

  // Fill location
  async fillLocation(location: string) {
    await this.locationInput.fill(location);
  }

  // Fill website
  async fillWebsite(website: string) {
    await this.websiteInput.fill(website);
  }

  // Fill private key
  async fillPrivateKey(key: string) {
    if (await this.privateKeyInput.isVisible()) {
      await this.privateKeyInput.fill(key);
    }
  }

  // Submit form
  async submit() {
    await this.submitButton.click();
  }

  // Create profile (full flow)
  async createProfile(data: {
    displayName: string;
    bio?: string;
    pronouns?: string;
    location?: string;
    website?: string;
    privateKey?: string;
  }) {
    await this.fillDisplayName(data.displayName);
    if (data.bio) await this.fillBio(data.bio);
    if (data.pronouns) await this.fillPronouns(data.pronouns);
    if (data.location) await this.fillLocation(data.location);
    if (data.website) await this.fillWebsite(data.website);
    if (data.privateKey) await this.fillPrivateKey(data.privateKey);
    await this.submit();
  }

  // Check if form is valid (submit button enabled)
  async isFormValid(): Promise<boolean> {
    return !(await this.submitButton.isDisabled());
  }

  // Get bio character count
  async getBioCharCount(): Promise<number> {
    const text = await this.bioCounter.textContent();
    const match = text?.match(/(\d+)\/200/);
    return match ? parseInt(match[1]) : 0;
  }
}
