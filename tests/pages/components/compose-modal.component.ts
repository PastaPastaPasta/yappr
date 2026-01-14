import { Page, Locator, expect } from '@playwright/test';

export class ComposeModalComponent {
  constructor(private page: Page) {}

  // Modal container
  get modal() {
    return this.page.locator('[role="dialog"]');
  }

  // Close button
  get closeButton() {
    return this.modal.locator('button').filter({ has: this.page.locator('svg') }).first();
  }

  // Textarea for post content
  get textarea() {
    return this.modal.locator('textarea');
  }

  // Character counter
  get characterCounter() {
    return this.modal.locator('span').filter({ hasText: /\/500/ });
  }

  // Post button
  get postButton() {
    return this.modal.getByRole('button', { name: /post/i });
  }

  // Reply indicator
  get replyIndicator() {
    return this.modal.getByText(/replying to/i);
  }

  // Wait for modal to open
  async waitForOpen(timeout: number = 5000) {
    await this.modal.waitFor({ state: 'visible', timeout });
  }

  // Wait for modal to close
  async waitForClose(timeout: number = 10000) {
    await this.modal.waitFor({ state: 'hidden', timeout });
  }

  // Check if modal is open
  async isOpen(): Promise<boolean> {
    return await this.modal.isVisible();
  }

  // Close the modal
  async close() {
    await this.closeButton.click();
    await this.waitForClose();
  }

  // Fill post content
  async fillContent(content: string) {
    await this.textarea.fill(content);
  }

  // Get current content
  async getContent(): Promise<string> {
    return await this.textarea.inputValue();
  }

  // Get character count
  async getCharacterCount(): Promise<number> {
    const text = await this.characterCounter.textContent();
    const match = text?.match(/(\d+)\/500/);
    return match ? parseInt(match[1]) : 0;
  }

  // Check if post button is enabled
  async isPostEnabled(): Promise<boolean> {
    return !(await this.postButton.isDisabled());
  }

  // Submit the post
  async submitPost() {
    await this.postButton.click();
  }

  // Create a post (full flow)
  async createPost(content: string, waitForClose: boolean = true) {
    await this.fillContent(content);
    await this.submitPost();
    if (waitForClose) {
      await this.waitForClose();
    }
  }

  // Check if this is a reply
  async isReply(): Promise<boolean> {
    return await this.replyIndicator.isVisible().catch(() => false);
  }
}
