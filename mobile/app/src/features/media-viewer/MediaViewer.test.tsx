import type { SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { POSTS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';

import { findCachedPost } from './cached-post';
import { MediaViewer } from './MediaViewer';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { back: jest.fn(), canGoBack: jest.fn(() => true) } }));

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

function renderViewer(postId: string, index = 0) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <MediaViewer postId={postId} initialIndex={index} />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
});

describe('findCachedPost', () => {
  it('finds a post anywhere in the engine cache, nested in a feed page', () => {
    const post = POSTS.fourImages;
    queryClient.setQueryData(queryKeys.feed.home({ tab: 'forYou' }), {
      pages: [{ items: [fixturePost({ id: 'other' }), post], cursor: null, hasMore: false }],
      pageParams: [null],
    });
    expect(findCachedPost(post.id)?.media).toHaveLength(4);
    expect(findCachedPost('nope')).toBeUndefined();
  });
});

describe('MediaViewer', () => {
  it('opens on the tapped item of a cached post, with its counter and controls (UX_SPEC §4.35)', async () => {
    const post = POSTS.fourImages;
    queryClient.setQueryData(queryKeys.feed.home({ tab: 'forYou' }), {
      pages: [{ items: [post], cursor: null, hasMore: false }],
      pageParams: [null],
    });
    fakeEngine.method('posts.get').mockResolvedValue(post);
    renderViewer(post.id, 2);
    await act(async () => {});

    expect(screen.getByText('3 / 4')).toBeTruthy();
    expect(screen.getAllByRole('image')).toHaveLength(4);
    fireEvent.press(screen.getByLabelText('Close image'));
    expect(router.back).toHaveBeenCalled();
  });

  it('shares the image URL and likes the post optimistically', async () => {
    const post = fixturePost({
      id: 'pic',
      media: [{ type: 'image', url: 'https://example.com/a.jpg', width: 800, height: 600 }],
      stats: { likes: 3, reposts: 0, replies: 0, quotes: 0 },
    });
    queryClient.setQueryData(queryKeys.post.detail('pic'), post);
    fakeEngine.method('posts.get').mockResolvedValue(post);
    fakeEngine.method('engage.like').mockResolvedValue(ticket({ op: 'like' }));
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderViewer('pic');
    await act(async () => {});

    expect(screen.queryByText('1 / 1')).toBeNull();
    fireEvent.press(screen.getByLabelText('Share image'));
    expect(share).toHaveBeenCalledWith({ url: 'https://example.com/a.jpg' });

    await act(async () => fireEvent.press(screen.getByLabelText('Like, 3 likes')));
    expect(fakeEngine.method('engage.like')).toHaveBeenCalledWith(expect.objectContaining({ id: 'pic' }));
    expect(screen.getByLabelText('Unlike, 4 likes')).toBeTruthy();
  });

  it('says "Image unavailable" for a post without media', async () => {
    fakeEngine.method('posts.get').mockResolvedValue(null);
    renderViewer('missing');
    await act(async () => {});
    expect(screen.getByText('Image unavailable')).toBeTruthy();
  });
});
