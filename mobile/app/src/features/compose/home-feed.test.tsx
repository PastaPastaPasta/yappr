import type { CapabilitiesDTO, Page, PostDTO, SessionDTO, WriteTicket } from '@engine/api';
import NetInfo from '@react-native-community/netinfo';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { advance, engineModule, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { useHomePrefsStore } from '~/features/home/home-prefs';
import { HomeScreen } from '~/features/home/HomeScreen';
import { resetOwnPosts } from '~/features/home/own-posts';
import { queryClient } from '~/state/query-client';
import { AUTHORS, fixturePost } from '~/ui/post/fixtures';

import { hasVisibleContent } from './limits';
import { publishPost, startPendingPosts, usePendingPosts, viewerAuthor } from './pending-posts';

/**
 * Compose's optimistic card on the real Home feed (PRD COMP-10, PD-3): it
 * shows on top of For You at once, survives a refetch that does not have it
 * yet, and becomes the one real post (never two cards) once `content.created`
 * and the confirmed ticket arrive, alongside Home's own pin of that post.
 */

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

// FlashList's own Jest setup (@shopify/flash-list/jestSetup): fixed layouts, so cells render.
jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => {
  const layout = { x: 0, y: 0, width: 400, height: 900 };
  return {
    ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
    measureParentSize: () => layout,
    measureFirstChildLayout: () => layout,
    measureItemLayout: () => ({ x: 0, y: 0, width: 400, height: 100 }),
  };
});

const CAPABILITIES = {
  rankings: true,
  windowedRankings: true,
  repostsAreQuotes: true,
  repostable: { post: true, reply: true },
  bookmarkable: { post: true, reply: false },
} as CapabilitiesDTO;

const viewer: SessionDTO = {
  identityId: AUTHORS.alice.id,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
const older = fixturePost({ id: 'p1', content: 'an older post', createdAt: at(5) }) as PostDTO;
const page = (items: PostDTO[]): Page<PostDTO> => ({ items, cursor: null, hasMore: false });
const home = () => fakeEngine.method('feed.home');
const FOR_YOU = queryKeys.feed.home({ tab: 'forYou' });

// The fake supervisor has no restart; Home's engine-down state calls it.
Object.assign(engineModule.engineSupervisor, { restart: jest.fn() });

function Layout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Stack />
    </QueryClientProvider>
  );
}

async function renderHome() {
  renderRouter({ _layout: Layout, index: HomeScreen, compose: () => null }, { initialUrl: '/' });
  act(() => {
    fireEvent(screen.getByTestId('home-pager'), 'layout', { nativeEvent: { layout: { width: 400, height: 800 } } });
  });
  await act(async () => {});
}

function publish(text: string): void {
  publishPost(
    {
      identityId: viewer.identityId,
      context: { mode: 'post', targetId: null },
      parts: [{ text, postedId: null }],
      sensitive: false,
      mediaUrl: null,
      target: null,
      author: viewerAuthor(viewer.identityId, 'alice'),
    },
    hasVisibleContent,
  );
}

const created = (t: WriteTicket, id: string) =>
  advance(t, {
    state: 'confirmed',
    documents: [{ contractId: 'social', type: 'post', id, action: 'create', part: 0, confirmed: true }],
  } as Partial<WriteTicket>);

let stop: () => void;
beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  stop = startPendingPosts();
});
afterAll(() => {
  stop();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
  resetOwnPosts();
});

beforeEach(() => {
  fakeEngine.reset();
  queryClient.clear();
  usePendingPosts.setState({ entries: {} });
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: CAPABILITIES } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useHomePrefsStore.setState({ accounts: {} });
  fakeEngine.method('feed.checkNew').mockResolvedValue({ count: 0, posts: [] });
  jest.mocked(NetInfo.useNetInfo).mockReturnValue({ isConnected: true } as ReturnType<typeof NetInfo.useNetInfo>);
});

const shownIds = () =>
  (queryClient.getQueryData<{ pages: Page<PostDTO>[] }>(FOR_YOU)?.pages ?? []).flatMap((p) => p.items.map((i) => i.id));

it('puts the posting card on top of For You, and it becomes the one real post (COMP-10, PD-3)', async () => {
  const t = ticket({ op: 'post.publish', identityId: viewer.identityId });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  home().mockResolvedValue(page([older]));
  await renderHome();

  await act(async () => publish('Fresh from compose'));

  // On top, with the write status in place of the action bar.
  expect(screen.getByText('Fresh from compose')).toBeTruthy();
  expect(screen.getByTestId('write-status')).toHaveTextContent('Posting…', { exact: false });
  expect(shownIds()[0]).toMatch(/^pending-/);
  expect(shownIds()[1]).toBe('p1');

  // A refetch that does not have it yet keeps it on top.
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: FOR_YOU });
  });
  expect(screen.getByText('Fresh from compose')).toBeTruthy();

  // The first part lands: the data layer seeds its detail, Home pins it, compose adopts it.
  const real = fixturePost({ id: 'real-1', content: 'Fresh from compose', author: AUTHORS.alice, createdAt: at(0) });
  await act(async () => {
    queryClient.setQueryData(queryKeys.post.detail('real-1'), real);
    fakeEngine.emit('content.created', { kind: 'post', id: 'real-1', confirmed: false, post: real });
  });
  expect(screen.getAllByText('Fresh from compose')).toHaveLength(1);
  expect(screen.getByTestId('write-status')).toBeTruthy();

  // Confirmed: the real post, its action bar back, still once.
  await act(async () => fakeEngine.emit('write.status', created(t, 'real-1')));
  expect(screen.getAllByText('Fresh from compose')).toHaveLength(1);
  expect(screen.queryByTestId('write-status')).toBeNull();
  expect(screen.getAllByLabelText(/^Like/).length).toBeGreaterThan(0);
  expect(shownIds()).toEqual(['real-1', 'p1']);
});
