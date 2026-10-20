import type { BlogDTO, BlogInfoDTO, BlogPostDTO, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionStore } from '~/data/session';
import { fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';

import { BlogPostScreen } from './BlogPostScreen';
import { EditPostScreen, NewPostScreen } from './PostEditorScreen';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
const mockParams: { current: Record<string, string> } = { current: {} };
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams.current,
}));
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

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
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
