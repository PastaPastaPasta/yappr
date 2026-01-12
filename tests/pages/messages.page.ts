import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class MessagesPage extends BasePage {
  // Conversations list
  get conversationsList() {
    return this.page.locator('[data-conversations], ul, div').filter({ has: this.page.locator('[data-conversation]') }).first();
  }

  get conversations() {
    return this.page.locator('[data-conversation], li, div').filter({ has: this.page.locator('img, [data-avatar]') });
  }

  // Search conversations
  get searchInput() {
    return this.page.getByPlaceholder(/search.*conversations|search.*messages/i);
  }

  // New conversation button
  get newConversationButton() {
    return this.page.getByRole('button', { name: /new|compose|start/i });
  }

  // Conversation thread elements
  get messageThread() {
    return this.page.locator('[data-messages], div').filter({ has: this.page.locator('[data-message]') }).first();
  }

  get messages() {
    return this.page.locator('[data-message], div').filter({ hasText: /.+/ });
  }

  get messageInput() {
    return this.page.getByPlaceholder(/message|type|write/i);
  }

  get sendButton() {
    return this.page.getByRole('button', { name: /send/i });
  }

  // Back button (mobile)
  get backButton() {
    return this.page.getByRole('button', { name: /back/i });
  }

  // Conversation header
  get conversationHeader() {
    return this.page.locator('header, div').filter({ has: this.page.locator('img, [data-avatar]') }).first();
  }

  get participantName() {
    return this.conversationHeader.locator('span, h2').first();
  }

  // Empty states
  get noConversations() {
    return this.page.getByText(/no conversations|no messages yet/i);
  }

  get noMessages() {
    return this.page.getByText(/no messages yet|start a conversation/i);
  }

  // New conversation modal
  get newConversationModal() {
    return this.page.locator('[role="dialog"]');
  }

  get participantInput() {
    return this.newConversationModal.getByPlaceholder(/username|identity/i);
  }

  get startConversationButton() {
    return this.newConversationModal.getByRole('button', { name: /start|create|send/i });
  }

  async goto() {
    await this.page.goto('/messages');
    await this.waitForPageLoad();
  }

  // Wait for conversations to load
  async waitForConversationsLoad(timeout: number = 30000) {
    await this.page.waitForLoadState('networkidle', { timeout });
  }

  // Search conversations
  async searchConversations(query: string) {
    await this.searchInput.fill(query);
    await this.page.waitForTimeout(500);
  }

  // Open conversation by index
  async openConversation(index: number = 0) {
    await this.conversations.nth(index).click();
    await this.page.waitForTimeout(500);
  }

  // Start new conversation
  async startNewConversation(participant: string, message: string) {
    await this.newConversationButton.click();
    await this.newConversationModal.waitFor({ state: 'visible' });
    await this.participantInput.fill(participant);
    await this.page.waitForTimeout(500);
    await this.startConversationButton.click();
    await this.page.waitForTimeout(500);
    // Send first message
    await this.sendMessage(message);
  }

  // Send message
  async sendMessage(message: string) {
    await this.messageInput.fill(message);
    await this.sendButton.click();
    await this.page.waitForTimeout(1000);
  }

  // Get conversation count
  async getConversationCount(): Promise<number> {
    await this.page.waitForTimeout(500);
    return await this.conversations.count();
  }

  // Get message count in current conversation
  async getMessageCount(): Promise<number> {
    await this.page.waitForTimeout(500);
    return await this.messages.count();
  }

  // Go back to conversations list (mobile)
  async goBack() {
    await this.backButton.click();
    await this.page.waitForTimeout(300);
  }

  // Get participant name of current conversation
  async getParticipantName(): Promise<string> {
    return await this.participantName.textContent() || '';
  }
}
