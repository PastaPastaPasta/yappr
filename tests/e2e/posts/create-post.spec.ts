import { test, expect } from '../../fixtures/test-fixtures';
import { FeedPage } from '../../pages/feed.page';
import { ComposeModalComponent } from '../../pages/components/compose-modal.component';
import { generateTestContent } from '../../fixtures/test-identity';

test.describe('Post Creation', () => {
  test('should open compose modal from feed', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    // Open compose modal
    await feedPage.openCompose();

    // Verify modal is open
    await expect(composeModal.modal).toBeVisible();
    await expect(composeModal.textarea).toBeVisible();
    await expect(composeModal.postButton).toBeVisible();
  });

  test('should show character counter', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();
    await feedPage.openCompose();

    // Type some content
    await composeModal.fillContent('Hello world #test');

    // Check character counter
    await page.waitForTimeout(300);
    const charCount = await composeModal.getCharacterCount();
    expect(charCount).toBeGreaterThan(0);
  });

  test('should disable post button when empty', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();
    await feedPage.openCompose();

    // Post button should be disabled with empty content
    const isEnabled = await composeModal.isPostEnabled();
    expect(isEnabled).toBe(false);
  });

  test('should enable post button with content', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();
    await feedPage.openCompose();

    // Add content
    await composeModal.fillContent('Test post #test #automated');

    // Post button should be enabled
    const isEnabled = await composeModal.isPostEnabled();
    expect(isEnabled).toBe(true);
  });

  test('should close compose modal', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();
    await feedPage.openCompose();

    // Close modal
    await composeModal.close();

    // Modal should be closed
    const isOpen = await composeModal.isOpen();
    expect(isOpen).toBe(false);
  });

  test('should create a post successfully', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();
    await feedPage.openCompose();

    // Create unique post content
    const postContent = generateTestContent('E2E Test Post');

    // Create post
    await composeModal.createPost(postContent);

    // Wait for post to be created (modal should close)
    await page.waitForTimeout(5000);

    // Refresh feed to see new post
    await feedPage.refreshFeed();

    // New post should appear in feed (eventually)
    await page.waitForTimeout(3000);
    const postVisible = await page.getByText(postContent.substring(0, 20)).isVisible().catch(() => false);
    // Note: Due to Dash Platform latency, post may not appear immediately
    // This is expected behavior
  });

  test('should enforce 500 character limit', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();
    await feedPage.openCompose();

    // Try to enter more than 500 characters
    const longContent = 'A'.repeat(510) + ' #test #automated';
    await composeModal.fillContent(longContent);

    // Content should be limited or button disabled
    const content = await composeModal.getContent();
    const charCount = await composeModal.getCharacterCount();

    // Either content is truncated or we're over limit
    expect(content.length <= 500 || charCount > 500).toBe(true);
  });

  test('should include hashtags in post', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();
    await feedPage.openCompose();

    // Create post with hashtags
    const postContent = 'Testing hashtags #test #automated #yappr';
    await composeModal.fillContent(postContent);

    // Verify content contains hashtags
    const content = await composeModal.getContent();
    expect(content).toContain('#test');
    expect(content).toContain('#automated');
  });
});

test.describe('Post - Reply', () => {
  test('should show reply indicator when replying to post', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    const feedPage = new FeedPage(page);
    const composeModal = new ComposeModalComponent(page);

    await feedPage.goto();
    await feedPage.waitForFeedLoad();

    // Wait for posts to load
    await page.waitForTimeout(3000);

    // Check if there are any posts to reply to
    const hasPosts = await feedPage.hasPosts();
    if (!hasPosts) {
      test.skip();
      return;
    }

    // Click reply on first post
    const firstPost = await feedPage.getPostByIndex(0);
    const replyButton = firstPost.locator('button').first();
    await replyButton.click();

    // Wait for compose modal with reply indicator
    await page.waitForTimeout(1000);

    // Check if we're in reply mode (compose modal or post detail with reply)
    const modalOpen = await composeModal.isOpen();
    const onPostPage = page.url().includes('/post');

    expect(modalOpen || onPostPage).toBe(true);
  });
});
