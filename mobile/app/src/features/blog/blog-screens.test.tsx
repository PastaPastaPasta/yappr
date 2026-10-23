import type { BlogCommentDTO, BlogDTO, BlogInfoDTO, BlogPostDTO, BlogPostSummaryDTO, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactElement } from 'react';
import { ActionSheetIOS, Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionStore } from '~/data/session';
import { resetWriteTracking } from '~/data/writes';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';
import { useToastStore } from '~/ui/toast';

import { BlogPostScreen } from './BlogPostScreen';
import { BlogScreen } from './BlogScreen';
import { ManageBlogsScreen } from './ManageBlogsScreen';
import { EditPostScreen, NewPostScreen } from './PostEditorScreen';
import { draftKey } from './blog-writes';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
const mockParams: { current: Record<string, string> } = { current: {} };
/** The latest options a screen gave its header (`gestureEnabled`). */
const mockOptions: { current: { gestureEnabled?: boolean } } = { current: {} };
/** Whether the screen is the one in front, as `navigation.isFocused()` answers. */
const mockFocused = { current: true };
const mockNavigation = { addListener: jest.fn(() => () => undefined), dispatch: jest.fn(), isFocused: () => mockFocused.current };
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  // Stack.Screen renders its header's right side here, so the tests can press it.
  Stack: {
    Screen: ({ options }: { options?: { gestureEnabled?: boolean; headerRight?: () => ReactElement } }) => {
      if (options && 'gestureEnabled' in options) mockOptions.current = options;
      return options?.headerRight?.() ?? null;
    },
  },
  useLocalSearchParams: () => mockParams.current,
  useNavigation: () => mockNavigation,
}));
// The leave guard: the latest callback the screen registered, as the stack calls it on Back or a swipe.
let mockPreventRemove: ((options: { data: { action: { type: string } } }) => void) | null = null;
jest.mock('expo-router/react-navigation', () => ({
  ...jest.requireActual('expo-router/react-navigation'),
  usePreventRemove: (prevent: boolean, callback: typeof mockPreventRemove) => {
    mockPreventRemove = prevent ? callback : null;
  },
}));
// The post's "…" menu: every item as a button, as the native menu would offer it.
jest.mock('~/ui/ContextMenu', () => {
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    ContextMenu: ({ items, onSelect, testID }: { items: { id: string; title: string }[]; onSelect: (id: string) => void; testID: string }) =>
      items.map((item) => (
        <Pressable key={item.id} onPress={() => onSelect(item.id)} testID={`${testID}-${item.id}`}>
          <Text>{item.title}</Text>
        </Pressable>
      )),
  };
});
jest.mock('@gorhom/bottom-sheet', () => jest.requireActual('@gorhom/bottom-sheet/mock'));

const AUTHOR = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
const READER = '8u9pqhrG1RbkuWvbqQ5WwFgaW2yGkVx2AYBnQ3j5vT1A';
const BLOG = 'B1YTHPCmXo6Yywxz2msLwxRZ5eWuUSMwfwiq258mzWyq';
const POST = '7mVtG4R4ZMTZ3veA95Y7fai8zDvX4HB6tPUGExyMZaVj';

const session = (identityId: string): SessionDTO => ({
  identityId,
  network: 'devnet',
  username: 'writer',
  credits: 1n,
  hasEncryptionKey: false,
  method: 'key',
});

const THEME = {
  colors: { bg: '#ffffff', text: '#111827', accent: '#0f172a', heading: '#020617', link: '#1d4ed8', surface: '#f8fafc', border: '#e2e8f0' },
  fonts: { body: 'source-serif-4', heading: 'playfair' },
  layout: 'narrow' as const,
  headerStyle: 'minimal' as const,
};

const INFO: BlogInfoDTO = {
  available: true,
  canDeleteBlog: true,
  canDeletePost: true,
  ownerPosts: true,
  reports: true,
  limits: { name: 64, description: 256, title: 128, summary: 255, comment: 500, image: 256, blogLabels: 64, postLabels: 16, labelLength: 40, reportNote: 500 },
  presets: [],
  fonts: [],
};

const blog: BlogDTO = {
  id: BLOG,
  ownerId: AUTHOR,
  owner: null,
  createdAt: new Date(2026, 9, 1),
  name: 'Field Journal',
  description: 'Notes',
  avatar: null,
  headerImage: null,
  theme: THEME,
  defaultTheme: false,
  commentsEnabledDefault: true,
  labels: [],
};

const CONTENT = [
  { id: 'h', type: 'heading', props: { level: 2, textAlignment: 'left' }, content: [{ type: 'text', text: 'First part', styles: {} }], children: [] },
  { id: 'toc', type: 'tableOfContents', props: {}, children: [] },
  { id: 'p', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Hello ', styles: {} }, { type: 'text', text: 'world', styles: { bold: true } }], children: [] },
  { id: 't', type: 'simpleTable', props: { rows: 1, cols: 1, data: '[["cell"]]' }, children: [] },
];

const post: BlogPostDTO = {
  id: POST,
  ownerId: AUTHOR,
  blogId: BLOG,
  blogName: null,
  slug: 'field-notes',
  title: 'Field notes',
  summary: 'A summary',
  excerpt: 'A summary',
  coverImage: null,
  labels: ['qa'],
  publishedAt: new Date(2026, 9, 2),
  date: new Date(2026, 9, 2),
  createdAt: new Date(2026, 9, 2),
  edited: false,
  readingMinutes: 1,
  commentsEnabled: true,
  deleted: false,
  content: CONTENT,
  summaryText: 'A summary',
  summaryHidden: false,
  revision: 1,
};

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function renderScreen(element: ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}

const settle = () => act(async () => {});

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

/** The open alert, or null. */
let alert: { title: string; press: (text: string) => void } | null = null;
/** The open action sheet, or null. */
let sheet: { options: string[]; choose: (label: string) => void } | null = null;
const GO_BACK = { data: { action: { type: 'GO_BACK' } } };

beforeEach(() => {
  jest.clearAllMocks();
  mockFocused.current = true;
  mockOptions.current = {};
  mockPreventRemove = null;
  alert = null;
  sheet = null;
  useToastStore.setState({ current: null });
  syncStorage.removeItem(draftKey(AUTHOR, BLOG));
  syncStorage.removeItem(`${draftKey(AUTHOR, BLOG)}:sent`);
  jest.spyOn(Alert, 'alert').mockImplementation((title, _message, buttons?: AlertButton[]) => {
    alert = { title, press: (text) => buttons?.find((b) => b.text === text)?.onPress?.() };
  });
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
    sheet = { options: options.options, choose: (label) => callback(options.options.indexOf(label)) };
  });
  fakeEngine.reset();
  queryClient.clear();
  // A comment left pending by an earlier test would queue the next one behind it (one per post at a time).
  resetWriteTracking();
  fakeEngine.setStatus({ state: 'ready', epoch: 1 });
  useSessionStore.setState({ status: 'signed-in', session: session(AUTHOR), accounts: [] });
  fakeEngine.method('blogs.info').mockResolvedValue(INFO);
  fakeEngine.method('blogs.get').mockResolvedValue(blog);
  fakeEngine.method('blogs.postBySlug').mockResolvedValue(post);
  fakeEngine.method('blogs.followState').mockResolvedValue({ following: false, followers: 3 });
  fakeEngine.method('blogs.comments').mockResolvedValue([]);
});

describe('post editor', () => {
  it('edits a post and sends only what changed, keeping blocks it cannot edit', async () => {
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    fakeEngine.method('blogs.edit').mockResolvedValue(ticket({ op: 'blogPost.update' }));
    renderScreen(<EditPostScreen />);
    await settle();

    expect(screen.getByText(/can only be changed on yap.pr \(Table\)/)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('blog-editor-title'), 'Field notes, revised');
    expect(screen.getByDisplayValue('Field notes, revised')).toBeTruthy();
    fireEvent.press(screen.getByTestId('blog-editor-submit'));
    await settle();

    expect(fakeEngine.method('blogs.edit')).toHaveBeenCalledWith(POST, { title: 'Field notes, revised' });
  });

  it('publishes new blocks in the web format', async () => {
    mockParams.current = { id: BLOG };
    fakeEngine.method('blogs.publish').mockResolvedValue(ticket({ op: 'blogPost.publish' }));
    renderScreen(<NewPostScreen />);
    await settle();

    fireEvent.changeText(screen.getByTestId('blog-editor-title'), 'Hello');
    fireEvent.changeText(screen.getByTestId('blog-editor-text-0'), 'Some **bold** words');
    fireEvent.press(screen.getByTestId('blog-editor-add-quote'));
    fireEvent.changeText(screen.getByTestId('blog-editor-text-1'), 'Quoted');
    fireEvent.press(screen.getByTestId('blog-editor-submit'));
    await settle();

    const [blogId, input] = fakeEngine.method('blogs.publish').mock.calls[0];
    expect(blogId).toBe(BLOG);
    expect(input).toMatchObject({ title: 'Hello', commentsEnabled: true, summaryHidden: false });
    expect(input.content.map((block: { type: string }) => block.type)).toEqual(['paragraph', 'quote']);
    expect(input.content[0].content).toEqual([
      { type: 'text', text: 'Some ', styles: {} },
      { type: 'text', text: 'bold', styles: { bold: true } },
      { type: 'text', text: ' words', styles: {} },
    ]);
  });

  it("refuses another author's blog", async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
    mockParams.current = { id: BLOG };
    renderScreen(<NewPostScreen />);
    await settle();
    expect(screen.getByText('You can only write on your own blogs')).toBeTruthy();
  });
});

describe('leaving the editor (MUX-3)', () => {
  const title = () => screen.getByTestId('blog-editor-title');

  it('asks before an edited post is left, and lets an unedited one go', async () => {
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    renderScreen(<EditPostScreen />);
    await settle();
    expect(mockPreventRemove).toBeNull();
    expect(mockOptions.current.gestureEnabled).toBe(true);

    fireEvent.changeText(title(), 'Field notes, revised');
    // The swipe is off, and Back (or Android's back) asks first.
    expect(mockOptions.current.gestureEnabled).toBe(false);
    act(() => mockPreventRemove?.(GO_BACK));
    expect(alert?.title).toBe('Discard changes?');
    await act(async () => alert?.press('Keep editing'));
    expect(mockNavigation.dispatch).not.toHaveBeenCalled();

    act(() => mockPreventRemove?.(GO_BACK));
    await act(async () => alert?.press('Discard'));
    expect(mockNavigation.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });

    // Typed back to what it was: nothing to lose, nothing asked.
    fireEvent.changeText(title(), 'Field notes');
    expect(mockPreventRemove).toBeNull();
  });

  it("keeps or deletes a new post's draft when it is left", async () => {
    mockParams.current = { id: BLOG };
    const first = renderScreen(<NewPostScreen />);
    await settle();
    expect(mockPreventRemove).toBeNull();

    fireEvent.changeText(title(), 'Unfinished');
    act(() => mockPreventRemove?.(GO_BACK));
    expect(sheet?.options).toEqual(['Save draft', 'Delete draft', 'Cancel']);
    act(() => sheet?.choose('Save draft'));
    expect(mockNavigation.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(syncStorage.getItem(draftKey(AUTHOR, BLOG)) ?? '{}').title).toBe('Unfinished');
    first.unmount();

    // Reopened, the draft is back as it was left: leaving asks nothing until it changes.
    renderScreen(<NewPostScreen />);
    await settle();
    expect(screen.getByDisplayValue('Unfinished')).toBeTruthy();
    expect(mockPreventRemove).toBeNull();
    fireEvent.changeText(title(), 'Unfinished, then changed');
    act(() => mockPreventRemove?.(GO_BACK));
    act(() => sheet?.choose('Delete draft'));
    expect(mockNavigation.dispatch).toHaveBeenCalledTimes(2);
    expect(syncStorage.getItem(draftKey(AUTHOR, BLOG))).toBeNull();
  });

  it("lets the account's stack reset take a dirty editor without asking, and saves nothing for it", async () => {
    mockParams.current = { id: BLOG };
    renderScreen(<NewPostScreen />);
    await settle();
    fireEvent.changeText(title(), 'Unfinished');
    const guard = mockPreventRemove;
    expect(guard).not.toBeNull();

    // A switch pops the tab stacks from the session store's listener, before the editor re-renders.
    act(() => {
      useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
      guard?.(GO_BACK);
    });
    expect(mockNavigation.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
    expect(alert).toBeNull();
    expect(sheet).toBeNull();
    expect(syncStorage.getItem(draftKey(AUTHOR, BLOG))).toBeNull();
  });

  it('closes a confirmed edit that is still in front, without asking', async () => {
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    const sent = ticket({ op: 'blogPost.update' });
    fakeEngine.method('blogs.edit').mockResolvedValue(sent);
    renderScreen(<EditPostScreen />);
    await settle();
    fireEvent.changeText(title(), 'Field notes, revised');
    fireEvent.press(screen.getByTestId('blog-editor-submit'));
    await settle();
    // On its way: leaving discards nothing, so nothing asks.
    expect(mockPreventRemove).toBeNull();
    expect(router.back).not.toHaveBeenCalled();

    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' })));
    await settle();
    expect(useToastStore.getState().current?.message).toBe('Post saved');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('pops nothing when an edit is confirmed after the writer moved on', async () => {
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    const sent = ticket({ op: 'blogPost.update' });
    fakeEngine.method('blogs.edit').mockResolvedValue(sent);
    renderScreen(<EditPostScreen />);
    await settle();
    fireEvent.changeText(title(), 'Field notes, revised');
    fireEvent.press(screen.getByTestId('blog-editor-submit'));
    await settle();

    mockFocused.current = false;
    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' })));
    await settle();
    expect(useToastStore.getState().current?.message).toBe('Post saved');
    expect(router.back).not.toHaveBeenCalled();
    // Back on it, the form is the saved one, editable, and leaving it asks nothing.
    expect(title().props.editable).toBe(true);
    expect(screen.getByDisplayValue('Field notes, revised')).toBeTruthy();
    expect(mockPreventRemove).toBeNull();
  });
});

describe('deleting a post (MUX-11)', () => {
  async function deletePost() {
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    renderScreen(<BlogPostScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('blog-post-menu-delete'));
    expect(alert?.title).toBe('Delete this post?');
    await act(async () => alert?.press('Delete'));
    await settle();
  }

  it('says it is deleting until the ticket confirms, and only then deleted', async () => {
    const sent = ticket({ op: 'blogPost.delete' });
    fakeEngine.method('blogs.deletePost').mockResolvedValue(sent);
    await deletePost();

    expect(fakeEngine.method('blogs.deletePost')).toHaveBeenCalledWith(POST);
    expect(screen.getByText('Deleting this post…')).toBeTruthy();
    expect(useToastStore.getState().current).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
    // Not offered again while it is on its way.
    expect(screen.queryByTestId('blog-post-menu-delete')).toBeNull();
    expect(screen.queryByTestId('blog-post-menu-edit')).toBeNull();

    // The read after it finds the post deleted; the screen still shows it while it leaves.
    fakeEngine.method('blogs.postBySlug').mockResolvedValue({ ...post, deleted: true });
    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' })));
    await settle();
    expect(useToastStore.getState().current?.message).toBe('Post deleted');
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(fakeEngine.method('blogs.postBySlug')).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('blog-post-title')).toHaveTextContent('Field notes');
    expect(screen.queryByText('This post was deleted by its author.')).toBeNull();
  });

  it('keeps an unconfirmed delete on screen until a read proves the post deleted', async () => {
    const sent = ticket({ op: 'blogPost.delete' });
    fakeEngine.method('blogs.deletePost').mockResolvedValue(sent);
    await deletePost();
    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'unconfirmed', retryable: false })));
    await settle();

    expect(screen.getByText(/Deleting this post was sent but isn't confirmed yet/)).toBeTruthy();
    expect(useToastStore.getState().current).toBeNull();
    expect(router.back).not.toHaveBeenCalled();

    fakeEngine.method('blogs.postBySlug').mockResolvedValue({ ...post, deleted: true });
    fireEvent.press(screen.getByTestId('blog-post-deletion-check'));
    await settle();
    expect(useToastStore.getState().current?.message).toBe('Post deleted');
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('says a failed delete failed, and offers it again', async () => {
    const sent = ticket({ op: 'blogPost.delete' });
    fakeEngine.method('blogs.deletePost').mockResolvedValue(sent);
    await deletePost();
    act(() => {
      fakeEngine.emit('write.status', advance(sent, {
        state: 'failed',
        retryable: true,
        error: { code: 'NETWORK', consensusCode: null, outcome: 'refused', retryable: true, userMessage: 'Network trouble.' },
      }));
    });
    await settle();

    expect(screen.getByText("This post wasn't deleted.")).toBeTruthy();
    expect(useToastStore.getState().current?.message).not.toBe('Post deleted');
    expect(router.back).not.toHaveBeenCalled();
    expect(screen.getByTestId('blog-post-menu-delete')).toBeTruthy();
  });

  it("says a retry whose answer was lost may still land, whatever the earlier one's outcome", async () => {
    const sent = ticket({ op: 'blogPost.delete' });
    fakeEngine.method('blogs.deletePost').mockResolvedValue(sent);
    await deletePost();
    act(() => {
      fakeEngine.emit('write.status', advance(sent, {
        state: 'failed',
        retryable: true,
        error: { code: 'NETWORK', consensusCode: null, outcome: 'refused', retryable: true, userMessage: 'Network trouble.' },
      }));
    });
    await settle();

    fakeEngine.method('blogs.deletePost').mockRejectedValue(Object.assign(new Error('Timed out'), { code: 'RPC_TIMEOUT' }));
    fireEvent.press(screen.getByTestId('blog-post-menu-delete'));
    await act(async () => alert?.press('Delete'));
    await settle();
    expect(screen.getByText(/Deleting this post was sent but isn't confirmed yet/)).toBeTruthy();
    expect(screen.queryByText("This post wasn't deleted.")).toBeNull();
  });

  it('offers to delete again once a read after a lost answer finds the post still there', async () => {
    fakeEngine.method('blogs.deletePost').mockRejectedValue(Object.assign(new Error('Timed out'), { code: 'RPC_TIMEOUT' }));
    await deletePost();
    expect(screen.getByText(/Deleting this post was sent but isn't confirmed yet/)).toBeTruthy();
    expect(screen.queryByTestId('blog-post-deletion-again')).toBeNull();

    fireEvent.press(screen.getByTestId('blog-post-deletion-check'));
    await settle();
    const sent = ticket({ op: 'blogPost.delete' });
    fakeEngine.method('blogs.deletePost').mockResolvedValue(sent);
    fireEvent.press(screen.getByTestId('blog-post-deletion-again'));
    await settle();
    expect(fakeEngine.method('blogs.deletePost')).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Deleting this post…')).toBeTruthy();
  });

  it('is still deleting while its call runs past the deadline', async () => {
    const sent = ticket({ op: 'blogPost.delete' });
    fakeEngine.method('blogs.deletePost').mockResolvedValue(sent);
    await deletePost();
    act(() => {
      fakeEngine.emit('write.status', advance(sent, {
        state: 'unconfirmed',
        retryable: false,
        error: { code: 'STILL_SENDING', consensusCode: null, outcome: 'unknown', retryable: false, userMessage: 'Still sending.' },
      }));
    });
    await settle();
    expect(screen.getByText('Deleting this post…')).toBeTruthy();
    expect(screen.queryByTestId('blog-post-deletion-check')).toBeNull();
  });

  it('never pops another screen when the delete confirms after the reader left', async () => {
    const sent = ticket({ op: 'blogPost.delete' });
    fakeEngine.method('blogs.deletePost').mockResolvedValue(sent);
    await deletePost();
    mockFocused.current = false;
    act(() => fakeEngine.emit('write.status', advance(sent, { state: 'confirmed' })));
    await settle();
    expect(useToastStore.getState().current?.message).toBe('Post deleted');
    expect(router.back).not.toHaveBeenCalled();
  });
});

describe('post reader', () => {
  it('shows the post, its table of contents and its comments box', async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    renderScreen(<BlogPostScreen />);
    await settle();

    expect(screen.getByTestId('blog-post-title')).toHaveTextContent('Field notes');
    expect(screen.getByLabelText('Table of contents')).toBeTruthy();
    expect(screen.getAllByText('First part').length).toBe(2);
    expect(screen.getByText('cell')).toBeTruthy();
    expect(screen.getByTestId('blog-comment-input')).toBeTruthy();
    expect(screen.getAllByLabelText('Follow this blog').length).toBeGreaterThan(0);
  });

  it('comments as the reader', async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    fakeEngine.method('blogs.comment').mockResolvedValue(ticket({ op: 'blogComment.create' }));
    renderScreen(<BlogPostScreen />);
    await settle();

    fireEvent.changeText(screen.getByTestId('blog-comment-input'), '  Nice post  ');
    fireEvent.press(screen.getByTestId('blog-comment-send'));
    await settle();
    expect(fakeEngine.method('blogs.comment')).toHaveBeenCalledWith(POST, AUTHOR, 'Nice post');
  });

  it('shows a sent comment at once and never sends it twice (D-954)', async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    fakeEngine.method('blogs.comment').mockResolvedValue(ticket({ op: 'blogComment.create' }));
    renderScreen(<BlogPostScreen />);
    await settle();
    expect(screen.getByTestId('blog-post-scroll').props.keyboardShouldPersistTaps).toBe('handled');

    fireEvent.changeText(screen.getByTestId('blog-comment-input'), 'Nice post');
    fireEvent.press(screen.getByTestId('blog-comment-send'));
    // The tap shows at once: the field clears, the button says it is posting, the comment is listed and counted.
    expect(screen.getByTestId('blog-comment-input').props.value).toBe('');
    expect(screen.getByLabelText('Posting your comment')).toBeTruthy();
    await settle();
    expect(screen.getByText('Nice post')).toBeTruthy();
    expect(screen.getByTestId('blog-comment-send')).toHaveTextContent('Posting…');
    expect(screen.getByText('1 comment')).toBeTruthy();

    // A second tap, and the same words again while the first is pending, send nothing.
    fireEvent.press(screen.getByTestId('blog-comment-send'));
    fireEvent.changeText(screen.getByTestId('blog-comment-input'), 'Nice post');
    fireEvent.press(screen.getByTestId('blog-comment-send'));
    await settle();
    expect(fakeEngine.method('blogs.comment')).toHaveBeenCalledTimes(1);
  });

  it('gives the words back when a sent comment fails, and drops it from the list', async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    const sent = ticket({ op: 'blogComment.create', identityId: READER });
    fakeEngine.method('blogs.comment').mockResolvedValue(sent);
    renderScreen(<BlogPostScreen />);
    await settle();

    fireEvent.changeText(screen.getByTestId('blog-comment-input'), 'Nice post');
    fireEvent.press(screen.getByTestId('blog-comment-send'));
    await settle();
    expect(screen.getByTestId('blog-comment-input').props.value).toBe('');
    act(() => {
      fakeEngine.emit('write.status', advance(sent, {
        state: 'failed',
        retryable: true,
        error: { code: 'NETWORK', consensusCode: null, outcome: 'refused', retryable: true, userMessage: 'Network trouble.' },
      }));
    });
    await settle();
    expect(screen.getByTestId('blog-comment-input').props.value).toBe('Nice post');
    expect(screen.queryByText('1 comment')).toBeNull();
  });

  it("doesn't send the same words again while they are still on their way", async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    const sent = ticket({ op: 'blogComment.create', identityId: READER });
    fakeEngine.method('blogs.comment').mockResolvedValue(sent);
    renderScreen(<BlogPostScreen />);
    await settle();

    fireEvent.changeText(screen.getByTestId('blog-comment-input'), 'Nice post');
    fireEvent.press(screen.getByTestId('blog-comment-send'));
    await settle();
    // Unconfirmed and not retryable: the button is free again, but the comment may still land.
    act(() => {
      fakeEngine.emit('write.status', advance(sent, { state: 'unconfirmed', retryable: false }));
    });
    await settle();
    fireEvent.changeText(screen.getByTestId('blog-comment-input'), ' Nice post ');
    fireEvent.press(screen.getByTestId('blog-comment-send'));
    await settle();
    expect(fakeEngine.method('blogs.comment')).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 comment')).toBeTruthy();
  });

  it('gives the words back when the comment is refused before it is sent', async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
    mockParams.current = { id: BLOG, slug: 'field-notes' };
    fakeEngine.method('blogs.comment').mockRejectedValue(Object.assign(new Error('Comments are off'), { code: 'BAD_REQUEST' }));
    renderScreen(<BlogPostScreen />);
    await settle();

    fireEvent.changeText(screen.getByTestId('blog-comment-input'), 'Nice post');
    fireEvent.press(screen.getByTestId('blog-comment-send'));
    await settle();
    expect(screen.getByTestId('blog-comment-input').props.value).toBe('Nice post');
    expect(screen.queryByText('1 comment')).toBeNull();
  });
});

/**
 * Blog v10 ("hide, don't delete"): the engine withholds what the moderators
 * hid on the official apps, labels it on an archival build, and labels the
 * author's own hidden or restricted blogs and posts in "Your blogs".
 */
describe('moderation (blog v10)', () => {
  const WITHHELD = { hidden: true, restricted: false, withheld: true } as const;
  const HIDDEN_AT = new Date(2026, 9, 21);
  const LABEL = { hidden: true, restricted: false, label: 3, reason: 'Spam or scam', at: HIDDEN_AT };
  const withheldPost: BlogPostDTO = {
    ...post, title: '', summary: null, excerpt: '', coverImage: null, labels: [], readingMinutes: 0, commentsEnabled: false,
    content: [], summaryText: '', summaryHidden: false, moderation: WITHHELD,
  };
  const comment = (id: string, extra: Partial<BlogCommentDTO> = {}): BlogCommentDTO => ({
    id, ownerId: READER, author: null, postId: POST, createdAt: new Date(2026, 9, 3), content: `comment ${id}`, ...extra,
  });

  beforeEach(() => {
    useSessionStore.setState({ status: 'signed-in', session: session(READER), accounts: [] });
    mockParams.current = { id: BLOG, slug: 'field-notes' };
  });

  it('shows a hidden post reached by its address as a stub, with none of it and no comments', async () => {
    fakeEngine.method('blogs.postBySlug').mockResolvedValue(withheldPost);
    renderScreen(<BlogPostScreen />);
    await settle();

    expect(screen.getByText('This blog post is hidden by moderators.')).toBeTruthy();
    expect(screen.queryByTestId('blog-post-title')).toBeNull();
    expect(screen.queryByTestId('blog-comment-input')).toBeNull();
    expect(fakeEngine.method('blogs.comments')).not.toHaveBeenCalled();
  });

  it("covers a hidden blog's posts with the blog's stub", async () => {
    fakeEngine.method('blogs.get').mockResolvedValue({ ...blog, name: '', description: null, moderation: WITHHELD });
    renderScreen(<BlogPostScreen />);
    await settle();

    expect(screen.getByText('This blog is hidden by moderators.')).toBeTruthy();
    expect(screen.queryByTestId('blog-post-title')).toBeNull();
  });

  it('labels a hidden post, and a restricted author\'s, on an archival build', async () => {
    fakeEngine.method('blogs.postBySlug').mockResolvedValue({ ...post, moderation: { ...LABEL, restricted: true } });
    renderScreen(<BlogPostScreen />);
    await settle();

    expect(screen.getByTestId('blog-post-title')).toHaveTextContent('Field notes');
    expect(screen.getByTestId('blog-post-moderation-label')).toHaveTextContent(/^Hidden · Spam or scam · .+ · Restricted account$/);
  });

  it('shows a hidden comment as a stub and labels one an archival build shows', async () => {
    fakeEngine.method('blogs.comments').mockResolvedValue([
      comment('C1'),
      comment('C2', { content: '', moderation: WITHHELD }),
      comment('C3', { moderation: LABEL }),
    ]);
    renderScreen(<BlogPostScreen />);
    await settle();

    expect(screen.getByText('comment C1')).toBeTruthy();
    expect(screen.getByTestId('blog-comment-hidden-C2')).toHaveTextContent('This comment is hidden by moderators.');
    expect(screen.queryByTestId('blog-comment-C2')).toBeNull();
    expect(screen.getByTestId('blog-comment-moderation-C3')).toHaveTextContent(/^Hidden · Spam or scam/);
    expect(screen.getByText('comment C3')).toBeTruthy();
  });

  it("shows a hidden blog's home as a stub and does not read its posts", async () => {
    mockParams.current = { id: BLOG };
    fakeEngine.method('blogs.get').mockResolvedValue({ ...blog, name: '', description: null, moderation: WITHHELD });
    renderScreen(<BlogScreen />);
    await settle();

    expect(screen.getByText('This blog is hidden by moderators.')).toBeTruthy();
    expect(fakeEngine.method('blogs.posts')).not.toHaveBeenCalled();
    expect(fakeEngine.method('blogs.followState')).not.toHaveBeenCalled();
  });

  it("labels the author's own hidden blog and hidden or restricted posts in Your blogs", async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(AUTHOR), accounts: [] });
    const HIDDEN_BLOG = 'H'.repeat(44);
    const summary = (id: string, extra: Partial<BlogPostSummaryDTO> = {}): BlogPostSummaryDTO => ({
      id, ownerId: AUTHOR, blogId: BLOG, blogName: 'Field Journal', slug: id, title: `Post ${id}`, summary: null, excerpt: '', coverImage: null, labels: [],
      publishedAt: post.publishedAt, date: post.date, createdAt: post.createdAt, edited: false, readingMinutes: 1, commentsEnabled: true, deleted: false, ...extra,
    });
    fakeEngine.method('blogs.mine').mockResolvedValue([blog, { ...blog, id: HIDDEN_BLOG, name: 'Quiet blog', moderation: LABEL }]);
    fakeEngine.method('blogs.myPosts').mockResolvedValue({
      items: [summary('P1'), summary('P2', { moderation: LABEL }), summary('P3', { moderation: { hidden: false, restricted: true } })],
      cursor: null,
      hasMore: false,
    });
    renderScreen(<ManageBlogsScreen />);
    await settle();

    expect(screen.getByText('Quiet blog')).toBeTruthy();
    expect(screen.queryByTestId(`manage-blog-moderation-${BLOG}`)).toBeNull();
    expect(screen.getByTestId(`manage-blog-moderation-${HIDDEN_BLOG}`)).toHaveTextContent(/^Hidden · Spam or scam/);
    expect(screen.queryByTestId('manage-post-moderation-P1')).toBeNull();
    expect(screen.getByTestId('manage-post-moderation-P2')).toHaveTextContent(/^Hidden · Spam or scam/);
    expect(screen.getByTestId('manage-post-moderation-P3')).toHaveTextContent('Restricted account');
  });
});

