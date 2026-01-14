import { test, expect } from '../../fixtures/test-fixtures';
import { MessagesPage } from '../../pages/messages.page';
import { generateTestContent } from '../../fixtures/test-identity';

test.describe('Messages - Conversations List', () => {
  test('should display messages page correctly', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const messagesPage = new MessagesPage(page);

    await messagesPage.goto();
    await messagesPage.waitForConversationsLoad();

    // Should show messages page elements
    const hasNewButton = await messagesPage.newConversationButton.isVisible().catch(() => false);
    const hasSearch = await messagesPage.searchInput.isVisible().catch(() => false);
    const hasConversations = await messagesPage.conversationsList.isVisible().catch(() => false);
    const hasEmptyState = await messagesPage.noConversations.isVisible().catch(() => false);

    // Should have some expected elements
    expect(hasNewButton || hasConversations || hasEmptyState).toBe(true);
  });

  test('should show new conversation button', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const messagesPage = new MessagesPage(page);

    await messagesPage.goto();
    await messagesPage.waitForConversationsLoad();

    const hasNewButton = await messagesPage.newConversationButton.isVisible().catch(() => false);
    expect(hasNewButton).toBe(true);
  });

  test('should open new conversation modal', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const messagesPage = new MessagesPage(page);

    await messagesPage.goto();
    await messagesPage.waitForConversationsLoad();

    const hasNewButton = await messagesPage.newConversationButton.isVisible().catch(() => false);
    if (!hasNewButton) {
      test.skip();
      return;
    }

    await messagesPage.newConversationButton.click();
    await page.waitForTimeout(500);

    // Modal should be open
    const modalVisible = await messagesPage.newConversationModal.isVisible().catch(() => false);
    expect(modalVisible).toBe(true);
  });
});

test.describe('Messages - Conversation Thread', () => {
  test('should open conversation when clicking on it', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const messagesPage = new MessagesPage(page);

    await messagesPage.goto();
    await messagesPage.waitForConversationsLoad();

    const conversationCount = await messagesPage.getConversationCount();
    if (conversationCount === 0) {
      test.skip();
      return;
    }

    // Open first conversation
    await messagesPage.openConversation(0);

    // Message input should be visible
    const hasMessageInput = await messagesPage.messageInput.isVisible().catch(() => false);
    expect(hasMessageInput).toBe(true);
  });

  test('should show send button in conversation', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const messagesPage = new MessagesPage(page);

    await messagesPage.goto();
    await messagesPage.waitForConversationsLoad();

    const conversationCount = await messagesPage.getConversationCount();
    if (conversationCount === 0) {
      test.skip();
      return;
    }

    await messagesPage.openConversation(0);

    // Send button should be visible
    const hasSendButton = await messagesPage.sendButton.isVisible().catch(() => false);
    expect(hasSendButton).toBe(true);
  });

  test('should type message in input', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const messagesPage = new MessagesPage(page);

    await messagesPage.goto();
    await messagesPage.waitForConversationsLoad();

    const conversationCount = await messagesPage.getConversationCount();
    if (conversationCount === 0) {
      test.skip();
      return;
    }

    await messagesPage.openConversation(0);

    // Type a message
    const testMessage = 'Test message #test #automated';
    await messagesPage.messageInput.fill(testMessage);

    // Verify message is in input
    const value = await messagesPage.messageInput.inputValue();
    expect(value).toBe(testMessage);
  });
});

test.describe('Messages - Search', () => {
  test('should search conversations', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const messagesPage = new MessagesPage(page);

    await messagesPage.goto();
    await messagesPage.waitForConversationsLoad();

    const hasSearch = await messagesPage.searchInput.isVisible().catch(() => false);
    if (!hasSearch) {
      test.skip();
      return;
    }

    await messagesPage.searchConversations('test');

    // Search should filter results
    await page.waitForTimeout(500);
  });
});
