import type { CapabilitiesDTO, SessionDTO, ThreadDTO, ThreadReplyDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import { queryKeys } from '~/data/keys';
import { useRemovedPosts } from '~/data/optimistic';
import { useSignInPrompt } from '~/data/require-auth';
import { useSessionStore } from '~/data/session';
import { fakeEngine } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { AUTHORS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';

import { ThreadScreen } from './ThreadScreen';
import { NOT_FOUND_RECHECK_MS } from './use-thread';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  Stack: { Screen: () => null },
}));

const CAPABILITIES = {
  repostsAreQuotes: true,
  deletesAreTombstones: false,
  repostable: { post: true, reply: true },
  bookmarkable: { post: true, reply: false },
} as CapabilitiesDTO;

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const root = fixturePost({ id: 'root', content: 'The root post', stats: { likes: 2, reposts: 0, replies: 2, quotes: 1 } });

function reply(id: string, content: string, overrides: Partial<ThreadReplyDTO> = {}): ThreadReplyDTO {
  return {
    ...fixturePost({ id, kind: 'reply', author: AUTHORS.carol, content, parentId: 'root', rootPostId: 'root' }),
    depth: 0,
    isAuthorThread: false,
    hiddenReplyCount: 0,
    ...overrides,
  };
}

function threadOf(replies: ThreadReplyDTO[], more: Partial<ThreadDTO> = {}, hasMore = false): ThreadDTO {
  return {
    focus: root,
    ancestors: [],
    removedAncestorIds: [],
    replies: { items: replies, cursor: hasMore ? 'next' : null, hasMore },
    ...more,
  };
}

function renderThread(id = 'root', highlightId?: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ThreadScreen id={id} highlightId={highlightId} />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  // The app retries a failed read once after a delay; these tests look at the failure itself.
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: CAPABILITIES } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useSignInPrompt.setState({ open: false });
  useRemovedPosts.setState({ ids: new Set() });
  fakeEngine.method('profiles.get').mockResolvedValue(null);
});

describe('ThreadScreen', () => {
  it('paints the tapped card at once, then lists the replies (POST-01, POST-02)', async () => {
    let resolve!: (thread: ThreadDTO) => void;
    fakeEngine.method('posts.thread').mockReturnValue(new Promise<ThreadDTO>((r) => (resolve = r)));
    queryClient.setQueryData(queryKeys.post.detail('root'), root);
    renderThread();

    expect(screen.getByText('The root post')).toBeTruthy();
    expect(screen.getByText('Loading replies…')).toBeTruthy();

    await act(async () => resolve(threadOf([reply('r1', 'First reply'), reply('r2', 'Second reply')])));
    expect(screen.getByText('First reply')).toBeTruthy();
    expect(screen.getByText('Second reply')).toBeTruthy();
    expect(screen.queryByText('Loading replies…')).toBeNull();
    expect(fakeEngine.method('posts.thread')).toHaveBeenCalledWith('root', null);
  });

  it('shows the empty state and the docked reply bar, which opens compose for the focus (POST-10)', async () => {
    fakeEngine.method('posts.thread').mockResolvedValue(threadOf([]));
    renderThread();
    await act(async () => {});

    expect(screen.getByText('No replies yet. Be the first to reply!')).toBeTruthy();
    fireEvent.press(screen.getByTestId('reply-bar'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/compose', params: { replyTo: 'root' } });
  });

  it('reads "Sign in to reply" signed out, and opens the sign-in sheet', async () => {
    useSessionStore.setState({ status: 'signed-out', session: null });
    fakeEngine.method('posts.thread').mockResolvedValue(threadOf([]));
    renderThread();
    await act(async () => {});

    fireEvent.press(screen.getByLabelText('Sign in to reply'));
    expect(useSignInPrompt.getState().open).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('replaces the reply bar on a deleted post', async () => {
    fakeEngine.method('posts.thread').mockResolvedValue(threadOf([], { focus: { ...root, deleted: true } }));
    renderThread();
    await act(async () => {});
    expect(screen.getByText("This post was deleted, so it can't be replied to.")).toBeTruthy();
    expect(screen.queryByTestId('reply-bar')).toBeNull();
  });

  it('says "Post not found" with Go back after re-checking a missing post', async () => {
    jest.useFakeTimers();
    try {
      fakeEngine.method('posts.thread').mockResolvedValue(threadOf([], { focus: null }));
      renderThread('missing');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(NOT_FOUND_RECHECK_MS);
      });
      expect(fakeEngine.method('posts.thread')).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Post not found')).toBeTruthy();
      fireEvent.press(screen.getByText('Go back'));
      expect(router.back).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the error state with Try again when the first read fails and nothing is cached', async () => {
    fakeEngine.method('posts.thread').mockRejectedValue(new Error('Request timed out'));
    renderThread();
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByText('Dash Platform is temporarily unavailable. Please try again in a few moments.')).toBeTruthy();

    fakeEngine.method('posts.thread').mockResolvedValue(threadOf([]));
    await act(async () => fireEvent.press(screen.getByText('Try again')));
    expect(screen.getByText('No replies yet. Be the first to reply!')).toBeTruthy();
  });

  it('titles a reply "Reply", reads its parent, and puts it above with "Replying to" (POST-03)', async () => {
    const focus = reply('r2', 'The focused reply', { parentId: 'r1', author: AUTHORS.alice });
    fakeEngine.method('posts.thread').mockResolvedValue(threadOf([], { focus, ancestors: [root] }));
    fakeEngine.method('posts.get').mockResolvedValue(reply('r1', 'The parent reply', { author: AUTHORS.carol }));
    renderThread('r2');
    await act(async () => {});
    await act(async () => {});

    expect(fakeEngine.method('posts.get')).toHaveBeenCalledWith('r1');
    expect(screen.getByTestId('ancestor-root')).toBeTruthy();
    expect(screen.getByTestId('ancestor-r1')).toBeTruthy();
    expect(screen.getByText('The focused reply')).toBeTruthy();
    expect(screen.getByText(/^Replying to/)).toBeTruthy();
    expect(screen.getAllByText('@carol').length).toBeGreaterThanOrEqual(2);
  });

  it('nests replies one level, with "Continue thread" and deleted stubs', async () => {
    fakeEngine.method('posts.thread').mockResolvedValue(
      threadOf([
        reply('r1', 'Top reply'),
        reply('r1a', 'Nested reply', { depth: 1, parentId: 'r1', hiddenReplyCount: 2 }),
        reply('gone', '', { deletedStub: true, author: { ...AUTHORS.carol, id: '' } }),
      ]),
    );
    renderThread();
    await act(async () => {});

    expect(screen.getByText('Nested reply')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Continue thread, 2 more replies'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/post/[id]', params: { id: 'r1a' } });
    expect(screen.getByTestId('reply-stub-gone')).toBeTruthy();
    expect(screen.getByText('This reply was deleted by its author.')).toBeTruthy();
  });

  it('pages replies cumulatively: the next page replaces the list', async () => {
    fakeEngine
      .method('posts.thread')
      .mockResolvedValueOnce(threadOf([reply('r1', 'Page one')], {}, true))
      .mockResolvedValueOnce(threadOf([reply('r1', 'Page one'), reply('r2', 'Page two')]));
    renderThread('root', 'r2');
    await act(async () => {});
    await act(async () => {});

    // Looking for the ?reply= target reads the next page on its own.
    expect(fakeEngine.method('posts.thread')).toHaveBeenLastCalledWith('root', 'next');
    expect(screen.getAllByText('Page one')).toHaveLength(1);
    expect(screen.getByText('Page two')).toBeTruthy();
  });

  it('opens engagements on a tab from the counts row', async () => {
    fakeEngine.method('posts.thread').mockResolvedValue(threadOf([]));
    renderThread();
    await act(async () => {});

    expect(screen.queryByTestId('count-reposts')).toBeNull();
    fireEvent.press(screen.getByTestId('count-likes'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/post/[id]/engagements',
      params: { id: 'root', kind: 'post', tab: 'likes' },
    });
  });
});
