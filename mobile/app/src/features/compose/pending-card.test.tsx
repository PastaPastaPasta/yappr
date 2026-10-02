import type { Page, PostDTO, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { PostItem } from '~/features/post/PostItem';
import { queryClient } from '~/state/query-client';
import { VIEWER_ID } from '~/ui/post/fixtures';

import { hasVisibleContent } from './limits';
import { publishPost, startPendingPosts, usePendingPosts, viewerAuthor } from './pending-posts';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const viewer = { identityId: VIEWER_ID, username: 'alice' } as SessionDTO;
const HOME = queryKeys.feed.home({ tab: 'forYou' });

/** A feed as screens render it: PostItem over the cached page. */
function Feed() {
  const { data } = useEngineQuery<InfiniteData<Page<PostDTO>>>(HOME, () => Promise.reject(new Error('no')), {
    enabled: false,
  });
  return <>{data?.pages[0]?.items.map((post) => <PostItem key={post.id} post={post} />)}</>;
}

let stop: () => void;
beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  stop = startPendingPosts();
});
afterAll(() => {
  stop();
  queryClient.clear();
});

beforeEach(() => {
  fakeEngine.reset();
  queryClient.clear();
  usePendingPosts.setState({ entries: {} });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  queryClient.setQueryData(HOME, { pages: [{ items: [], cursor: null, hasMore: false }], pageParams: [null] });
});

it('shows the optimistic card with its write status, then Retry · Edit on failure', async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  render(
    <QueryClientProvider client={queryClient}>
      <Feed />
    </QueryClientProvider>,
  );

  await act(async () => {
    publishPost(
      {
        identityId: VIEWER_ID,
        context: { mode: 'post', targetId: null },
        parts: [{ text: 'Fresh post', postedId: null }],
        sensitive: false,
        mediaUrl: null,
        target: null,
        author: viewerAuthor(VIEWER_ID, 'alice'),
      },
      hasVisibleContent,
    );
  });

  expect(screen.getByText('Fresh post')).toBeTruthy();
  expect(screen.getByTestId('write-status')).toHaveTextContent('Posting…', { exact: false });
  // No action bar on a card still posting.
  expect(screen.queryByLabelText(/^Like/)).toBeNull();

  const error = { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: false, userMessage: 'No.' } as const;
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'failed', error })));
  expect(screen.getByTestId('write-status')).toHaveTextContent("Couldn't post", { exact: false });

  fireEvent.press(screen.getByText('Edit'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/compose', params: {} });
  expect(screen.queryByText('Fresh post')).toBeNull();
});
