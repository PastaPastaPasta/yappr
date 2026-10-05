import type {
  BlockedUserDTO,
  CapabilitiesDTO,
  DmStatusDTO,
  EngineErrorCode,
  OwnReportDTO,
  PostDTO,
  ProfileDTO,
  SessionDTO,
  SettingsDTO,
} from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import type { ReactElement } from 'react';
import { Alert, Linking, View, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking, sendWrite } from '~/data/writes';
import { PostItem } from '~/features/post/PostItem';
import { queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';
import { AUTHORS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { BlockedAccountsScreen } from './BlockedAccountsScreen';
import { blockWrite, resetBlockDecisions } from './block-state';
import { BlockScreen } from './BlockScreen';
import { copy } from './copy';
import { ReportScreen } from './ReportScreen';
import { usePostSafety } from './use-post-safety';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: jest.fn(() => ({})),
  Stack: { Screen: () => null },
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => {
  const layout = { x: 0, y: 0, width: 400, height: 900 };
  return {
    ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
    measureParentSize: () => layout,
    measureFirstChildLayout: () => layout,
    measureItemLayout: () => ({ x: 0, y: 0, width: 400, height: 100 }),
  };
});

const BOB = AUTHORS.bob;
const CAPABILITIES = {
  reports: true,
  reportsResolved: true,
  repostable: { post: true, reply: true },
  bookmarkable: { post: true, reply: true },
} as CapabilitiesDTO;

const SETTINGS: SettingsDTO = {
  linkPreviewsEnabled: true,
  gateMediaFromNonFollowed: true,
  sendReadReceipts: false,
  sensitiveContentMode: 'blur',
  notificationSettings: {
    likes: true,
    reposts: true,
    replies: true,
    follows: true,
    mentions: true,
    messages: true,
    blogPosts: true,
  },
  payWith: 'credits',
  feedLanguage: 'en',
};

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const IMAGE = { type: 'image' as const, url: 'https://example.com/a.jpg', width: 1200, height: 675 };

/** `dm.status` on DM v5, with Messages unlocked on this device or not. */
function dmStatus(locked: boolean): DmStatusDTO {
  return {
    backend: 'v5',
    locked,
    ready: !locked,
    unreadTotal: 0,
    unreadConversations: 0,
    capReached: false,
    retention: locked ? null : 'never',
    blocked: [],
    recovery: null,
    error: null,
  };
}

function profileOf(blocks: boolean): ProfileDTO {
  return {
    id: BOB.id,
    username: 'bob',
    usernames: ['bob'],
    displayName: BOB.displayName,
    avatar: BOB.avatar,
    hasProfile: true,
    stats: { posts: 3, followers: 1, following: 2 },
    viewer: { follows: false, blocks, blockedBy: blocks ? 'self' : null, isSelf: false },
  };
}

const params = useLocalSearchParams as jest.Mock;
const toastMessage = () => useToastStore.getState().current?.message;
const settle = () => act(async () => undefined);

function withProviders(ui: ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}
    >
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}

/** A list of posts read from the cache, as feeds render them, so optimistic changes show. */
function CachedList({ removal }: { removal?: 'hide' | 'stub' }) {
  const { data } = useEngineQuery(queryKeys.feed.home({ tab: 'forYou' }), async () => [] as PostDTO[], {
    enabled: false,
  });
  return (
    <View>
      {(data ?? []).map((post) => (
        <PostItem key={post.id} post={post} removal={removal} />
      ))}
    </View>
  );
}

function renderPosts(posts: PostDTO[], removal?: 'hide' | 'stub') {
  queryClient.setQueryData(queryKeys.feed.home({ tab: 'forYou' }), posts);
  return withProviders(<CachedList removal={removal} />);
}

function setSettings(patch: Partial<SettingsDTO>) {
  queryClient.setQueryData(queryKeys.settings, { ...SETTINGS, ...patch });
}

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  resetWriteTracking();
  resetBlockDecisions();
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: CAPABILITIES } });
  fakeEngine.method('settings.get').mockResolvedValue(SETTINGS);
  setSettings({});
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useToastStore.setState({ current: null });
  params.mockReturnValue({});
});

describe('content gates on posts', () => {
  it('covers NSFW posts in Warn first, shows them in Always show', () => {
    renderPosts([fixturePost({ id: 'nsfw', sensitive: true })]);
    expect(screen.getByTestId('sensitive-gate')).toBeTruthy();

    act(() => setSettings({ sensitiveContentMode: 'show' }));
    expect(screen.queryByTestId('sensitive-gate')).toBeNull();
  });

  it('drops a bare repost of an NSFW post in Hide, but keeps the cover on other cards', () => {
    const target = fixturePost({ id: 'target', sensitive: true });
    const repost = fixturePost({ id: 'repost', author: AUTHORS.carol, content: '', bareRepost: true, quoted: target, quotedPostId: 'target' });
    setSettings({ sensitiveContentMode: 'hide' });
    renderPosts([repost, fixturePost({ id: 'flagged', sensitive: true })]);

    expect(screen.queryByTestId('post-card-target')).toBeNull();
    expect(screen.getByTestId('post-card-flagged')).toBeTruthy();
    expect(screen.getByTestId('sensitive-gate')).toBeTruthy();
  });

  it('holds back media from authors the viewer does not follow until Show', () => {
    const stranger = fixturePost({
      id: 'stranger',
      media: [IMAGE],
      viewer: { ...fixturePost().viewer!, followsAuthor: false },
    });
    renderPosts([stranger, fixturePost({ id: 'friend', media: [IMAGE] })]);

    expect(screen.getAllByTestId('media-gate')).toHaveLength(1);
    fireEvent.press(screen.getByTestId('media-gate-show'));
    expect(screen.queryByTestId('media-gate')).toBeNull();
  });

  it("gates a stranger's card without attachments too, so a link-preview image waits", () => {
    const textOnly = fixturePost({ id: 'link', viewer: { ...fixturePost().viewer!, followsAuthor: false } });
    const { result } = renderHook(() => usePostSafety(textOnly, textOnly, 'hide', VIEWER_ID), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    expect(result.current.gates.mediaGated).toBe(true);
    act(() => result.current.gates.onRevealMedia());
    expect(result.current.gates.mediaGated).toBe(false);
  });

  it('never gates own media, gates everyone signed out, and gates nothing with the setting off', () => {
    const own = fixturePost({ id: 'own', author: AUTHORS.alice, media: [IMAGE] });
    renderPosts([own]);
    expect(screen.queryByTestId('media-gate')).toBeNull();

    act(() => useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] }));
    expect(screen.getByTestId('media-gate')).toBeTruthy();

    act(() => setSettings({ gateMediaFromNonFollowed: false }));
    expect(screen.queryByTestId('media-gate')).toBeNull();
  });

  describe('while the engine restores the session (D-L3a-009)', () => {
    const stranger = () =>
      fixturePost({ id: 'stranger', media: [IMAGE], viewer: { ...fixturePost().viewer!, followsAuthor: false } });
    const cards = () => [
      fixturePost({ id: 'own', author: AUTHORS.alice, media: [IMAGE] }),
      fixturePost({ id: 'friend', media: [IMAGE] }),
      stranger(),
    ];

    beforeEach(() => useSessionStore.setState({ status: 'unknown', session: null, accounts: [] }));
    afterEach(() => syncStorage.removeItem('yappr.session.identity'));

    it("never flashes the gate on the last account's own or followed media", () => {
      syncStorage.setItem('yappr.session.identity', VIEWER_ID);
      renderPosts(cards());
      expect(screen.getAllByTestId('media-gate')).toHaveLength(1);

      // Restored signed out after all: everything waits behind Show again.
      act(() => useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] }));
      expect(screen.getAllByTestId('media-gate')).toHaveLength(3);
    });

    it('gates everything when nobody was signed in last time', () => {
      renderPosts(cards());
      expect(screen.getAllByTestId('media-gate')).toHaveLength(3);
    });
  });

  it('gates until the settings answer (nothing flagged shows before)', () => {
    queryClient.removeQueries({ queryKey: queryKeys.settings });
    fakeEngine.method('settings.get').mockReturnValue(new Promise(() => undefined));
    renderPosts([fixturePost({ id: 'early', sensitive: true })]);
    expect(screen.getByTestId('sensitive-gate')).toBeTruthy();
  });
});

describe('blocking', () => {
  const bobPosts = () => [
    fixturePost({ id: 'b1' }),
    fixturePost({ id: 'b2', content: 'Second post' }),
    fixturePost({ id: 'c1', author: AUTHORS.carol }),
  ];

  it("removes the author's posts from lists at once, and brings them back when the block fails", async () => {
    const pending = ticket({ op: 'block', target: { identityId: BOB.id } });
    fakeEngine.method('safety.block').mockResolvedValue(pending);
    renderPosts(bobPosts());

    const user = { username: 'bob', displayName: 'Bob', avatar: BOB.avatar };
    await act(async () =>
      sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true, user }, copy.toast.blocked('@bob')),
    );
    expect(fakeEngine.method('safety.block')).toHaveBeenCalledWith(BOB.id, null);
    expect(screen.queryByTestId('post-card-b1')).toBeNull();
    expect(screen.queryByTestId('post-card-b2')).toBeNull();
    expect(screen.getByTestId('post-card-c1')).toBeTruthy();
    expect(toastMessage()).toBe('Blocked @bob');
    // No Messages capability: nothing to block there.
    expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();

    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          error: { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: false, userMessage: '' },
        }),
      ),
    );
    expect(screen.getByTestId('post-card-b1')).toBeTruthy();
    // The block's own sentence, naming who; web's generic text never shows.
    expect(toastMessage()).toBe("Couldn't block @bob. Try again.");
  });

  it('collapses a blocked author in threads, and their quotes everywhere', async () => {
    fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
    const quote = fixturePost({ id: 'q1', author: AUTHORS.carol, quotedPostId: 'b1', quoted: fixturePost({ id: 'b1' }) });
    renderPosts([fixturePost({ id: 'r1', kind: 'reply' }), quote], 'stub');

    await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
    expect(screen.getByText('Reply from an account you blocked')).toBeTruthy();
    expect(screen.getByText('Post from an account you blocked')).toBeTruthy();
    expect(screen.getByTestId('post-card-q1')).toBeTruthy();
  });

  it('asks the engine, in one batch, whether quoted authors are blocked from before this session', async () => {
    fakeEngine.method('safety.isBlocked').mockResolvedValue({ [BOB.id]: true, [AUTHORS.carol.id]: false });
    const quoteOf = (id: string, quoted: PostDTO) =>
      fixturePost({ id, author: AUTHORS.alice, quotedPostId: quoted.id, quoted });
    renderPosts([
      quoteOf('q1', fixturePost({ id: 'b1' })),
      quoteOf('q2', fixturePost({ id: 'c1', author: AUTHORS.carol, content: 'Carol says hi' })),
    ]);
    await settle();

    expect(fakeEngine.method('safety.isBlocked')).toHaveBeenCalledTimes(1);
    expect(fakeEngine.method('safety.isBlocked').mock.calls[0][0]).toEqual(
      expect.arrayContaining([BOB.id, AUTHORS.carol.id]),
    );
    expect(screen.getAllByText('Post from an account you blocked')).toHaveLength(1);
    expect(screen.getByText('Carol says hi')).toBeTruthy();
  });

  it('keeps a block made here across a relaunch, before the lists are read again (SR-25)', async () => {
    fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
    renderPosts(bobPosts());
    await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
    expect(screen.queryByTestId('post-card-b1')).toBeNull();

    // A relaunch: the decisions in memory are gone, the persisted feed is what the engine read before the block.
    act(() => resetBlockDecisions());
    expect(screen.queryByTestId('post-card-b1')).toBeNull();
  });

  it('never caches a failed block-status read as "not blocked" (SR-31)', async () => {
    fakeEngine.method('safety.isBlocked').mockRejectedValue(Object.assign(new Error('offline'), { code: 'NETWORK' }));
    renderPosts([fixturePost({ id: 'q1', author: AUTHORS.alice, quotedPostId: 'b1', quoted: fixturePost({ id: 'b1' }) })]);
    await settle();
    expect(fakeEngine.method('safety.isBlocked')).toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.blockStatus(BOB.id))).toBeUndefined();

    // The engine answers on the next ask: the quote collapses.
    fakeEngine.method('safety.isBlocked').mockResolvedValue({ [BOB.id]: true });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.blockStatusAll });
    });
    expect(screen.getByText('Post from an account you blocked')).toBeTruthy();
  });

  it('forgets block decisions when the account changes, so the engine decides again', async () => {
    fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
    renderPosts(bobPosts());
    await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
    expect(screen.queryByTestId('post-card-b1')).toBeNull();

    // Signed out, then back in: an unblock made elsewhere meanwhile shows. (The sign-out resets the
    // cache; the posts read again say not blocked.)
    act(() => useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] }));
    act(() => useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] }));
    act(() => queryClient.setQueryData(queryKeys.feed.home({ tab: 'forYou' }), bobPosts()));
    expect(screen.getByTestId('post-card-b1')).toBeTruthy();
  });

  it('keeps a post the engine reports as blocked out of lists', () => {
    renderPosts([fixturePost({ id: 'b1', viewer: { ...fixturePost().viewer!, authorBlocked: true } })]);
    expect(screen.queryByTestId('post-card-b1')).toBeNull();
  });

  it('marks only what the engine filters by block status stale once confirmed', async () => {
    const pending = ticket({ op: 'block', target: { identityId: BOB.id } });
    fakeEngine.method('safety.block').mockResolvedValue(pending);
    const keys = {
      feed: queryKeys.feed.home({ tab: 'forYou' }),
      detail: queryKeys.post.detail('x'),
      thread: queryKeys.post.thread('x'),
      stats: queryKeys.post.stats('x'),
      ownReport: queryKeys.post.ownReport('x'),
      profilePosts: queryKeys.profile.posts(BOB.id, 'posts'),
      followers: queryKeys.profile.followers(BOB.id),
    };
    for (const key of Object.values(keys)) queryClient.setQueryData(key, []);
    await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));

    const stale = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
    expect([keys.feed, keys.detail, keys.thread, keys.profilePosts].map(stale)).toEqual([true, true, true, true]);
    expect([keys.stats, keys.ownReport, keys.followers].map(stale)).toEqual([false, false, false]);
  });

  it('says a followed block list still blocks after an unblock', async () => {
    const pending = ticket({ op: 'unblock', target: { identityId: BOB.id } });
    fakeEngine.method('safety.unblock').mockResolvedValue(pending);
    await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: false }));
    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          error: { code: 'STILL_BLOCKED', consensusCode: null, outcome: 'local', retryable: false, userMessage: 'x' },
        }),
      ),
    );
    expect(toastMessage()).toBe(copy.toast.stillBlocked);
    expect(toastMessage()).toBe('Unblocked, but a block list you follow still hides them.');
  });

  describe('on DM v5, one Block covers Messages too (SAFE-01, SAFE-02)', () => {
    const failed = {
      state: 'failed' as const,
      error: { code: 'UNKNOWN' as const, consensusCode: null, outcome: 'refused' as const, retryable: false, userMessage: '' },
    };

    beforeEach(() => {
      fakeEngine.setStatus({ state: 'ready', info: { capabilities: { ...CAPABILITIES, dm: 'v5' } } });
      // The engine says whether the call changed anything.
      fakeEngine.method('dm.setBlocked').mockResolvedValue(true);
    });

    it('blocks them in Messages with the block, and lifts that again when the block fails', async () => {
      const pending = ticket({ op: 'block', target: { identityId: BOB.id } });
      fakeEngine.method('safety.block').mockResolvedValue(pending);
      await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
      expect(fakeEngine.method('dm.setBlocked')).toHaveBeenCalledWith(BOB.id, true);

      await act(async () => fakeEngine.emit('write.status', advance(pending, failed)));
      expect(fakeEngine.method('dm.setBlocked').mock.calls).toEqual([
        [BOB.id, true],
        [BOB.id, false],
      ]);
    });

    describe('a block and an unblock that overlap, the second refused (QA rc7 review)', () => {
      const unconfirmed = { state: 'unconfirmed' as const };
      /** Bob's posts as a read brings them, with the block status the chain holds. */
      const read = (authorBlocked: boolean) =>
        queryClient.setQueryData(
          queryKeys.feed.home({ tab: 'forYou' }),
          bobPosts().map((post) => ({ ...post, viewer: { ...post.viewer!, authorBlocked } })),
        );
      const settle = () =>
        act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

      it('keeps Bob blocked, on screen and in Messages, when an unblock after an unconfirmed block is refused', async () => {
        renderPosts(bobPosts());
        const blocking = ticket({ op: 'block', target: { identityId: BOB.id } });
        fakeEngine.method('safety.block').mockResolvedValue(blocking);
        await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
        act(() => fakeEngine.emit('write.status', advance(blocking, unconfirmed)));
        const unblocking = ticket({ op: 'unblock', target: { identityId: BOB.id } });
        fakeEngine.method('safety.unblock').mockResolvedValue(unblocking);
        await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: false }));
        expect(screen.getByTestId('post-card-b1')).toBeTruthy();

        // The block landed; the unblock is refused, changing nothing on the chain.
        fakeEngine.method('safety.blockedBy').mockResolvedValue({ [BOB.id]: 'self' });
        await act(async () => fakeEngine.emit('write.status', advance(unblocking, failed)));
        await settle();
        act(() => read(true));
        expect(screen.queryByTestId('post-card-b1')).toBeNull();
        expect(fakeEngine.method('dm.setBlocked').mock.calls.at(-1)).toEqual([BOB.id, true]);
      });

      it('keeps Bob unblocked, on screen and in Messages, when a block after an unconfirmed unblock is refused', async () => {
        renderPosts(bobPosts().map((post) => ({ ...post, viewer: { ...post.viewer!, authorBlocked: true } })));
        const unblocking = ticket({ op: 'unblock', target: { identityId: BOB.id } });
        fakeEngine.method('safety.unblock').mockResolvedValue(unblocking);
        await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: false }));
        act(() => fakeEngine.emit('write.status', advance(unblocking, unconfirmed)));
        const blocking = ticket({ op: 'block', target: { identityId: BOB.id } });
        fakeEngine.method('safety.block').mockResolvedValue(blocking);
        await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
        expect(screen.queryByTestId('post-card-b1')).toBeNull();

        // The unblock landed; the block is refused.
        fakeEngine.method('safety.blockedBy').mockResolvedValue({ [BOB.id]: null });
        await act(async () => fakeEngine.emit('write.status', advance(blocking, failed)));
        await settle();
        act(() => read(false));
        expect(screen.getByTestId('post-card-b1')).toBeTruthy();
        expect(fakeEngine.method('dm.setBlocked').mock.calls.at(-1)).toEqual([BOB.id, false]);
      });
    });

    it('keeps a block in Messages made before (on web) when a profile block fails', async () => {
      const pending = ticket({ op: 'block', target: { identityId: BOB.id } });
      fakeEngine.method('safety.block').mockResolvedValue(pending);
      // Already blocked in Messages: the engine changed nothing.
      fakeEngine.method('dm.setBlocked').mockResolvedValue(false);
      await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
      await act(async () => fakeEngine.emit('write.status', advance(pending, failed)));
      expect(fakeEngine.method('dm.setBlocked').mock.calls).toEqual([[BOB.id, true]]);
    });

    it('lifts the block in Messages with an unblock, also when a followed block list keeps the posts hidden', async () => {
      const pending = ticket({ op: 'unblock', target: { identityId: BOB.id } });
      fakeEngine.method('safety.unblock').mockResolvedValue(pending);
      await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: false }));
      expect(fakeEngine.method('dm.setBlocked')).toHaveBeenCalledWith(BOB.id, false);

      await act(async () =>
        fakeEngine.emit(
          'write.status',
          advance(pending, {
            state: 'failed',
            error: { code: 'STILL_BLOCKED', consensusCode: null, outcome: 'local', retryable: false, userMessage: 'x' },
          }),
        ),
      );
      // The own block is gone all the same, so Messages stays unblocked: the undo never re-blocks it.
      expect(fakeEngine.method('dm.setBlocked').mock.calls.every(([, blocked]) => blocked === false)).toBe(true);
    });

    it('never lets an older undo override a newer choice', async () => {
      const block = ticket({ op: 'block', target: { identityId: BOB.id } });
      fakeEngine.method('safety.block').mockResolvedValue(block);
      let changed: (value: boolean) => void = () => undefined;
      fakeEngine.method('dm.setBlocked').mockReturnValueOnce(new Promise((resolve) => (changed = resolve)));
      await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
      await act(async () => fakeEngine.emit('write.status', advance(block, failed)));
      // A new block before the first call answered: the first one's undo stays out of it.
      const again = ticket({ op: 'block', target: { identityId: BOB.id } });
      fakeEngine.method('safety.block').mockResolvedValue(again);
      await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
      await act(async () => changed(true));
      expect(fakeEngine.method('dm.setBlocked').mock.calls).toEqual([
        [BOB.id, true],
        [BOB.id, true],
      ]);
    });

    it('never touches Messages on the legacy backend, which follows the account blocks itself', async () => {
      fakeEngine.setStatus({ state: 'ready', info: { capabilities: { ...CAPABILITIES, dm: 'legacy' } } });
      fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
      await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
      expect(fakeEngine.method('dm.setBlocked')).not.toHaveBeenCalled();
    });
  });
});

describe('BlockScreen', () => {
  beforeEach(() => params.mockReturnValue({ userId: BOB.id }));

  it('asks first, sends the note, and closes', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profileOf(false));
    fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
    withProviders(<BlockScreen />);
    await settle();

    expect(screen.getByText('Block @bob?')).toBeTruthy();
    // The public note waits behind "Add a note".
    expect(screen.queryByTestId('block-note')).toBeNull();
    fireEvent.press(screen.getByTestId('block-add-note'));
    expect(screen.getByText('Anyone can see this note.')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('block-note'), '  spam bot  ');
    await act(async () => fireEvent.press(screen.getByTestId('block-confirm')));

    expect(fakeEngine.method('safety.block')).toHaveBeenCalledWith(BOB.id, { message: 'spam bot' });
    expect(router.back).toHaveBeenCalled();
    expect(toastMessage()).toBe('Blocked @bob');
  });

  it('blocks without a note when none was added', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profileOf(false));
    fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
    withProviders(<BlockScreen />);
    await settle();
    await act(async () => fireEvent.press(screen.getByTestId('block-confirm')));
    expect(fakeEngine.method('safety.block')).toHaveBeenCalledWith(BOB.id, null);
  });

  it.each([
    [
      'v5',
      "They won't be able to message you, and you won't see their posts or replies. Blocks are public on Dash Platform.",
    ],
    [
      'legacy',
      "You won't see their posts or replies. They can still message you, but it won't show as unread. Blocks are public on Dash Platform.",
    ],
    [undefined, "You won't see their posts or replies. Blocks are public on Dash Platform."],
  ] as const)('promises only what a block does to %s messages (SR-20)', async (dm, body) => {
    fakeEngine.setStatus({ state: 'ready', info: { capabilities: { ...CAPABILITIES, dm } as CapabilitiesDTO } });
    fakeEngine.method('profiles.get').mockResolvedValue(profileOf(false));
    fakeEngine.method('dm.status').mockResolvedValue(dmStatus(false));
    withProviders(<BlockScreen />);
    await settle();
    expect(screen.getByText(body)).toBeTruthy();
  });

  it('on DM v5 with Messages locked on this device, promises nothing about messages', async () => {
    fakeEngine.setStatus({ state: 'ready', info: { capabilities: { ...CAPABILITIES, dm: 'v5' } } });
    fakeEngine.method('profiles.get').mockResolvedValue(profileOf(false));
    fakeEngine.method('dm.status').mockResolvedValue(dmStatus(true));
    withProviders(<BlockScreen />);
    await settle();
    expect(screen.getByText("You won't see their posts or replies. Blocks are public on Dash Platform.")).toBeTruthy();
    expect(screen.queryByText(/message you/)).toBeNull();
  });

  it('on DM v5, blocks them in Messages too from the sheet', async () => {
    fakeEngine.setStatus({ state: 'ready', info: { capabilities: { ...CAPABILITIES, dm: 'v5' } } });
    fakeEngine.method('dm.status').mockResolvedValue(dmStatus(false));
    fakeEngine.method('profiles.get').mockResolvedValue(profileOf(false));
    fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
    fakeEngine.method('dm.setBlocked').mockResolvedValue(undefined);
    withProviders(<BlockScreen />);
    await settle();
    await act(async () => fireEvent.press(screen.getByTestId('block-confirm')));
    expect(fakeEngine.method('dm.setBlocked')).toHaveBeenCalledWith(BOB.id, true);
    expect(toastMessage()).toBe('Blocked @bob');
  });

  it('offers Unblock for an account already blocked', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profileOf(true));
    fakeEngine.method('safety.unblock').mockResolvedValue(ticket({ op: 'unblock' }));
    withProviders(<BlockScreen />);
    await settle();

    expect(screen.getByText('You blocked @bob')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('unblock-confirm')));
    expect(fakeEngine.method('safety.unblock')).toHaveBeenCalledWith(BOB.id);
    expect(toastMessage()).toBe('Unblocked @bob');
  });

  it('keeps the profile it holds when a refetch fails', async () => {
    queryClient.setQueryData(queryKeys.profile.detail(BOB.id), profileOf(false), { updatedAt: 1 });
    fakeEngine.method('profiles.get').mockRejectedValue(new Error('offline'));
    withProviders(<BlockScreen />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(screen.queryByTestId('block-error')).toBeNull();
    expect(screen.getByTestId('block-confirm')).toBeTruthy();
  });

  it('paints a cached name at once, and waits for the block status before offering anything', async () => {
    queryClient.setQueryData(queryKeys.feed.home({ tab: 'forYou' }), [fixturePost({ id: 'b1' })]);
    fakeEngine.method('profiles.get').mockReturnValue(new Promise(() => undefined));
    withProviders(<BlockScreen />);
    await settle();
    expect(screen.getByText(BOB.displayName)).toBeTruthy();
    expect(screen.getByTestId('block-loading')).toBeTruthy();
    expect(screen.queryByTestId('block-confirm')).toBeNull();
    expect(screen.queryByTestId('unblock-confirm')).toBeNull();
  });

  it('refuses to block yourself, and asks to sign in when signed out', () => {
    params.mockReturnValue({ userId: VIEWER_ID });
    const { unmount } = withProviders(<BlockScreen />);
    expect(screen.getByText('You cannot block yourself')).toBeTruthy();
    unmount();

    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
    params.mockReturnValue({ userId: BOB.id });
    withProviders(<BlockScreen />);
    expect(screen.getByText(copy.block.signIn)).toBeTruthy();
  });
});

describe('ReportScreen', () => {
  const post = fixturePost({ id: 'p1' });
  const target = { id: 'p1', kind: 'post' as const, ownerId: BOB.id, rootPostId: null };
  const refused = (code: EngineErrorCode) => ({
    state: 'failed' as const,
    error: { code, consensusCode: null, outcome: 'refused' as const, retryable: false, userMessage: 'x' },
  });

  beforeEach(() => {
    params.mockReturnValue({ postId: 'p1', kind: 'post' });
    fakeEngine.method('posts.get').mockResolvedValue(post);
    fakeEngine.method('safety.reportsOpen').mockResolvedValue(true);
  });

  it('files a report with its reason and note, then offers to block', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    withProviders(<ReportScreen />);
    await settle();

    expect(
      screen.getByText(
        'Reports are public. Anyone, including the author, can see that you reported this, your reason and any details.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('report-submit')).toBeDisabled();
    fireEvent.press(screen.getByTestId('report-reason-8'));
    expect(screen.getByText('Details (required)')).toBeTruthy();
    expect(screen.getByTestId('report-submit')).toBeDisabled();
    fireEvent.changeText(screen.getByTestId('report-note'), 'Phishing link');
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));

    expect(fakeEngine.method('safety.report')).toHaveBeenCalledWith(target, 8, 'Phishing link');
    expect(screen.getByText('Reporting…')).toBeTruthy();

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(screen.getByTestId('report-sent')).toBeTruthy();
    expect(screen.getByText('Thanks for letting us know.')).toBeTruthy();
    // The sheet says it; no toast on top.
    expect(toastMessage()).toBeUndefined();
    expect(screen.getByText('Also block @bob')).toBeTruthy();
    fireEvent.press(screen.getByTestId('report-also-block'));
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/block/[userId]', params: { userId: BOB.id } });
  });

  it('counts a report the network has not confirmed yet as sent, and brings the form back only when it proved absent', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));

    const unconfirmed = advance(pending, {
      state: 'unconfirmed',
      error: { code: 'TIMEOUT', consensusCode: null, outcome: 'unknown', retryable: false, userMessage: 'x' },
    });
    act(() => fakeEngine.emit('write.status', unconfirmed));
    expect(screen.getByTestId('report-sent')).toBeTruthy();
    expect(screen.queryByText(/not confirmed/i)).toBeNull();
    expect(toastMessage()).toBeUndefined();

    // A check proved it never landed: the form is back with the reason chosen, and the toast says so.
    act(() =>
      fakeEngine.emit('write.status', advance(unconfirmed, { retryable: true, lastCheckedAt: new Date() })),
    );
    expect(screen.getByTestId('report-sheet')).toBeTruthy();
    expect(screen.getByTestId('report-submit')).toBeEnabled();
    expect(toastMessage()).toMatch(/report/i);
  });

  it('shows a report not confirmed yet as sent when the sheet reopens, never the form for a second one', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    const first = withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'unconfirmed',
          error: { code: 'TIMEOUT', consensusCode: null, outcome: 'unknown', retryable: false, userMessage: 'x' },
        }),
      ),
    );
    first.unmount();

    withProviders(<ReportScreen />);
    await settle();
    expect(screen.getByTestId('report-sent')).toBeTruthy();
    expect(screen.queryByTestId('report-submit')).toBeNull();
  });

  it('sends one report for a double tap, and says it went when the sheet closed before the engine took it', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target });
    let answer: (value: typeof pending) => void = () => undefined;
    fakeEngine.method('safety.report').mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { unmount } = withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    fireEvent.press(screen.getByTestId('report-submit'));
    fireEvent.press(screen.getByTestId('report-submit'));
    unmount();
    await act(async () => answer(pending));
    expect(fakeEngine.method('safety.report')).toHaveBeenCalledTimes(1);
    expect(toastMessage()).toBe('Report sent');

    // Its confirmation is reconciled silently, and nothing was queued behind it to go out now.
    act(() => useToastStore.setState({ current: null }));
    await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(toastMessage()).toBeUndefined();
    expect(fakeEngine.method('safety.report')).toHaveBeenCalledTimes(1);
  });

  it('follows a report still on its way when the sheet is dismissed and reopened, and sends no second one', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    const first = withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    first.unmount();
    // Dismissed while it was on its way: the toast says it went.
    expect(toastMessage()).toBe('Report sent');
    act(() => useToastStore.setState({ current: null }));

    const second = withProviders(<ReportScreen />);
    await settle();
    // The reopened sheet shows the first report going out, not a fresh form.
    expect(screen.getByText('Reporting…')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(screen.getByTestId('report-sent')).toBeTruthy();
    expect(fakeEngine.method('safety.report')).toHaveBeenCalledTimes(1);
    // The sheet says it now, and the report was already announced: no toast on top, nor when it closes.
    second.unmount();
    expect(toastMessage()).toBeUndefined();
  });

  it('says "Report sent" once when the sheet is dismissed while the report is on its way, and nothing more when it confirms', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    const sheet = withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    expect(screen.getByText('Reporting…')).toBeTruthy();
    expect(toastMessage()).toBeUndefined();

    sheet.unmount();
    expect(toastMessage()).toBe('Report sent');
    act(() => useToastStore.setState({ current: null }));
    await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(toastMessage()).toBeUndefined();
  });

  it('drops a report sent from a reopened sheet before the first one has its ticket', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target });
    let answer: (value: typeof pending) => void = () => undefined;
    fakeEngine.method('safety.report').mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const first = withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    fireEvent.press(screen.getByTestId('report-submit'));
    first.unmount();

    withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-1'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    await act(async () => answer(pending));
    expect(screen.getByText('Reporting…')).toBeTruthy();
    await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(screen.getByTestId('report-sent')).toBeTruthy();
    expect(fakeEngine.method('safety.report')).toHaveBeenCalledTimes(1);
  });

  it("shows the form at once while it reads the viewer's report, and the report once it is found", async () => {
    let found: (report: OwnReportDTO | null) => void = () => undefined;
    fakeEngine.method('safety.ownReport').mockReturnValue(new Promise((resolve) => (found = resolve)));
    withProviders(<ReportScreen />);
    await settle();
    expect(screen.getByTestId('report-sheet')).toBeTruthy();
    expect(screen.queryByText(/Checking/)).toBeNull();

    await act(async () =>
      found({ id: 'r1', reason: 0, note: null, createdAt: new Date(2026, 8, 30), status: null, resolution: null, moderatedAt: null }),
    );
    expect(screen.getByTestId('report-existing')).toBeTruthy();
    expect(screen.queryByTestId('report-submit')).toBeNull();
  });

  it('lets the report go when that read fails, and shows the report a DUPLICATE refusal finds', async () => {
    fakeEngine.method('safety.ownReport').mockRejectedValue(new Error('unavailable'));
    const pending = ticket({ op: 'report', target });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    withProviders(<ReportScreen />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(screen.getByTestId('report-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    expect(fakeEngine.method('safety.report')).toHaveBeenCalledTimes(1);

    fakeEngine.method('safety.ownReport').mockResolvedValue({
      id: 'r1', reason: 0, note: null, createdAt: new Date(2026, 8, 30), status: null, resolution: null, moderatedAt: null,
    });
    await act(async () => fakeEngine.emit('write.status', advance(pending, refused('DUPLICATE'))));
    await settle();
    expect(toastMessage()).toBe('You already reported this.');
    expect(screen.getByTestId('report-existing')).toBeTruthy();
  });

  it('trusts a listed copy when the fresh read finds nothing, and says gone without one', async () => {
    fakeEngine.method('posts.get').mockResolvedValue(null);
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    queryClient.setQueryData(queryKeys.feed.home({ tab: 'forYou' }), [post]);
    const { unmount } = withProviders(<ReportScreen />);
    await settle();
    expect(screen.getByTestId('report-sheet')).toBeTruthy();
    unmount();

    queryClient.clear();
    setSettings({});
    withProviders(<ReportScreen />);
    await settle();
    expect(screen.getByText('This post no longer exists.')).toBeTruthy();
  });

  it("says the post couldn't load when it can't be read, never that the report check failed", async () => {
    fakeEngine.method('posts.get').mockRejectedValue(new Error('unavailable'));
    withProviders(<ReportScreen />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(screen.getByTestId('report-error')).toBeTruthy();
    expect(screen.getByText("Couldn't load this post. Try again.")).toBeTruthy();
  });

  it.each([
    [2, null, 'You reported this on Sep 30, 2026 for spam or scam · Resolved: Content removed'],
    [null, null, 'You reported this on Sep 30, 2026 for spam or scam · Under review'],
  ] as const)('shows an existing report instead of the form (status %s)', async (status, _resolution, line) => {
    const report: OwnReportDTO = {
      id: 'r1',
      reason: 0,
      note: 'Same link everywhere',
      createdAt: new Date(2026, 8, 30, 12),
      status,
      resolution: null,
      moderatedAt: status === null ? null : new Date(2026, 9, 1, 12),
    };
    fakeEngine.method('safety.ownReport').mockResolvedValue(report);
    withProviders(<ReportScreen />);
    await settle();

    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText('Same link everywhere')).toBeTruthy();
    expect(screen.getByText('Reports close after 90 days.')).toBeTruthy();
    expect(screen.queryByTestId('report-submit')).toBeNull();
  });

  describe('withdrawing an existing report (SAFE-04)', () => {
    const report: OwnReportDTO = {
      id: 'r1',
      reason: 8,
      note: 'Phishing link',
      createdAt: new Date('2026-09-30T12:00:00Z'),
      status: null,
      resolution: null,
      moderatedAt: null,
    };
    let answer: (choice: 'Withdraw' | 'Cancel') => void = () => undefined;

    beforeEach(() => {
      fakeEngine.method('safety.ownReport').mockResolvedValue(report);
      jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons?: AlertButton[]) => {
        answer = (choice) => buttons?.find((button) => button.text === choice)?.onPress?.();
      });
    });

    afterEach(() => jest.mocked(Alert.alert).mockRestore());

    async function withdraw() {
      const pending = ticket({ op: 'report.withdraw', target });
      fakeEngine.method('safety.withdrawReport').mockResolvedValue(pending);
      const sheet = withProviders(<ReportScreen />);
      await settle();
      fireEvent.press(screen.getByTestId('report-withdraw'));
      await act(async () => answer('Withdraw'));
      return { pending, sheet };
    }

    it('asks first, then withdraws at once: "Report withdrawn", and the sheet closes', async () => {
      const pending = ticket({ op: 'report.withdraw', target });
      fakeEngine.method('safety.withdrawReport').mockResolvedValue(pending);
      withProviders(<ReportScreen />);
      await settle();

      expect(screen.getByTestId('report-done')).toBeTruthy();
      fireEvent.press(screen.getByTestId('report-withdraw'));
      expect(Alert.alert).toHaveBeenCalledWith(
        copy.report.withdrawTitle,
        copy.report.withdrawBody,
        expect.arrayContaining([expect.objectContaining({ text: 'Withdraw', style: 'destructive' })]),
        expect.anything(),
      );
      await act(async () => answer('Withdraw'));
      expect(fakeEngine.method('safety.withdrawReport')).toHaveBeenCalledWith(target, 'r1');
      expect(toastMessage()).toBe('Report withdrawn');
      expect(router.back).toHaveBeenCalledTimes(1);
      // The sheet keeps the report on screen while it closes, though the cache dropped it.
      expect(screen.getByTestId('report-existing')).toBeTruthy();
      expect(queryClient.getQueryData(queryKeys.post.ownReport('p1'))).toBeNull();

      act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
      expect(router.back).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(queryKeys.post.ownReport('p1'))).toBeNull();
    });

    it('sends nothing when the confirmation is cancelled', async () => {
      withProviders(<ReportScreen />);
      await settle();
      fireEvent.press(screen.getByTestId('report-withdraw'));
      await act(async () => answer('Cancel'));
      expect(fakeEngine.method('safety.withdrawReport')).not.toHaveBeenCalled();
      expect(screen.getByText(copy.report.withdraw)).toBeTruthy();
    });

    it('brings the report back only when the withdrawal fails', async () => {
      const { pending } = await withdraw();
      act(() =>
        fakeEngine.emit(
          'write.status',
          advance(pending, {
            state: 'failed',
            error: { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: false, userMessage: '' },
          }),
        ),
      );
      expect(toastMessage()).toBe("Couldn't withdraw your report. Try again.");
      expect(queryClient.getQueryData(queryKeys.post.ownReport('p1'))).toEqual(report);
    });

    it('says so in a neutral toast when the report is already closed, and reads it again', async () => {
      const { pending } = await withdraw();
      fakeEngine.method('safety.ownReport').mockResolvedValue(null);
      await act(async () => fakeEngine.emit('write.status', advance(pending, refused('REPORT_GONE'))));
      await settle();
      expect(useToastStore.getState().current).toMatchObject({ kind: 'info', message: 'This report was already closed.' });
      expect(fakeEngine.method('safety.ownReport')).toHaveBeenCalledTimes(2);
    });

    it('never keeps the closed report cached once its sheet is gone', async () => {
      const { pending, sheet } = await withdraw();
      sheet.unmount();
      await act(async () => fakeEngine.emit('write.status', advance(pending, refused('REPORT_GONE'))));
      expect(queryClient.getQueryData(queryKeys.post.ownReport('p1'))).toBeNull();

      // Reopened, the sheet offers the form, not Withdraw for a report that is gone.
      fakeEngine.method('safety.ownReport').mockResolvedValue(null);
      withProviders(<ReportScreen />);
      expect(screen.queryByTestId('report-withdraw')).toBeNull();
      await settle();
      expect(screen.getByTestId('report-sheet')).toBeTruthy();
    });

    it('reconciles a withdrawal not confirmed yet silently, and a reopened sheet never offers Withdraw again', async () => {
      const { pending, sheet } = await withdraw();
      sheet.unmount();
      act(() => useToastStore.setState({ current: null }));
      act(() =>
        fakeEngine.emit(
          'write.status',
          advance(pending, {
            state: 'unconfirmed',
            error: { code: 'TIMEOUT', consensusCode: null, outcome: 'unknown', retryable: false, userMessage: 'x' },
          }),
        ),
      );
      expect(toastMessage()).toBeUndefined();

      withProviders(<ReportScreen />);
      await settle();
      expect(screen.getByTestId('report-withdrawn')).toBeTruthy();
      expect(screen.queryByTestId('report-withdraw')).toBeNull();
      expect(screen.queryByTestId('report-submit')).toBeNull();
      expect(fakeEngine.method('safety.withdrawReport')).toHaveBeenCalledTimes(1);
    });

    it('checks an unconfirmed withdrawal by itself once its sheet is gone, and still says nothing', async () => {
      const pending = ticket({ op: 'report.withdraw', identityId: VIEWER_ID, target });
      fakeEngine.method('safety.withdrawReport').mockResolvedValue(pending);
      const sheet = withProviders(<ReportScreen />);
      await settle();
      fireEvent.press(screen.getByTestId('report-withdraw'));
      await act(async () => answer('Withdraw'));
      sheet.unmount();
      // "Report withdrawn" showed when the engine took it (optimistic); the network's answer is silent.
      act(() => useToastStore.setState({ current: null }));
      jest.useFakeTimers();
      try {
        const unconfirmed = advance(pending, { state: 'unconfirmed' });
        fakeEngine.method('writes.check').mockImplementation(async () => {
          const confirmed = advance(unconfirmed, { state: 'confirmed', lastCheckedAt: new Date() });
          fakeEngine.emit('write.status', confirmed);
          return confirmed;
        });
        act(() => fakeEngine.emit('write.status', unconfirmed));
        expect(toastMessage()).toBeUndefined();
        await act(async () => {
          await jest.advanceTimersByTimeAsync(5_000);
        });
        expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(pending.id);
        expect(toastMessage()).toBeUndefined();
        expect(queryClient.getQueryData(queryKeys.post.ownReport('p1'))).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('goes straight to email where reports wait for a moderation team that is not seated', async () => {
    fakeEngine.method('safety.reportsOpen').mockResolvedValue(false);
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(true);
    withProviders(<ReportScreen />);
    await settle();

    expect(screen.getByTestId('report-email')).toBeTruthy();
    expect(screen.queryByTestId('report-sheet')).toBeNull();
    expect(screen.queryByTestId('report-refused')).toBeNull();
    expect(screen.getByText('Report by email')).toBeTruthy();
    expect(
      screen.getByText(
        'Reports go to the Yappr team by email for now. Your email app opens with a link to the post and the reason you chose.',
      ),
    ).toBeTruthy();
    // The link stays inside the email.
    expect(screen.queryByText(/\/post\?id=p1/)).toBeNull();
    expect(screen.getByTestId('report-email-send')).toBeDisabled();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    fireEvent.changeText(screen.getByTestId('report-note'), 'Same link everywhere');
    await act(async () => fireEvent.press(screen.getByTestId('report-email-send')));
    expect(decodeURIComponent(openURL.mock.calls[0]?.[0] ?? '')).toContain(
      '/post?id=p1\n\nReason: Spam or scam\n\nSame link everywhere',
    );
    expect(fakeEngine.method('safety.report')).not.toHaveBeenCalled();
  });

  it('offers email with what was chosen when the network refuses for want of a seated team', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    act(() => fakeEngine.emit('write.status', advance(pending, refused('MODERATION_NOT_SEATED'))));
    expect(screen.getByTestId('report-refused')).toBeTruthy();
    expect(screen.getAllByText("Your report wasn't sent. Send it by email instead.").length).toBeGreaterThan(0);
    expect(screen.getByTestId('report-email-send')).toBeEnabled();
    expect(screen.queryByText(/elects its moderation team|Nothing was posted/)).toBeNull();
  });

  it("opens the email report from a post's menu even signed out, where the contract takes no reports", () => {
    fakeEngine.setStatus({ info: { capabilities: { ...CAPABILITIES, reports: false } } });
    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
    renderPosts([post]);
    act(() =>
      fireEvent(screen.getByTestId('more-menu-p1'), 'pressAction', { nativeEvent: { event: 'report' } }),
    );
    expect(router.push).toHaveBeenCalledWith({ pathname: '/report/[postId]', params: { postId: 'p1', kind: 'post' } });
  });

  it('reports by email where the contract takes no reports, copying when no mail app opens', async () => {
    fakeEngine.setStatus({ info: { capabilities: { ...CAPABILITIES, reports: false } } });
    const openURL = jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('no mail app'));
    queryClient.setQueryData(queryKeys.post.detail('p1'), post);
    withProviders(<ReportScreen />);

    expect(screen.getByText('Report by email')).toBeTruthy();
    fireEvent.press(screen.getByTestId('report-reason-1'));
    await act(async () => fireEvent.press(screen.getByTestId('report-email-send')));

    const url = openURL.mock.calls[0]?.[0] ?? '';
    expect(url).toMatch(/^mailto:support@yap\.pr\?subject=Report%3A%20post%20p1&body=/);
    expect(decodeURIComponent(url)).toContain('/post?id=p1\n\nReason: Harassment or bullying');
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(expect.stringContaining('support@yap.pr'));
    expect(toastMessage()).toBe(copy.toast.reportCopied);
    expect(fakeEngine.method('safety.report')).not.toHaveBeenCalled();
    expect(fakeEngine.method('safety.reportsOpen')).not.toHaveBeenCalled();
  });
});

describe('BlockedAccountsScreen', () => {
  const blocked: BlockedUserDTO[] = [
    { ...BOB, message: 'Spam' },
    { ...AUTHORS.carol, message: null },
  ];

  it('lists blocks with their notes, and unblocks at once', async () => {
    fakeEngine.method('safety.blocked').mockResolvedValue({ items: blocked, cursor: null, hasMore: false });
    fakeEngine.method('safety.unblock').mockResolvedValue(ticket({ op: 'unblock' }));
    withProviders(<BlockedAccountsScreen />);
    await settle();

    expect(screen.getByText('Spam')).toBeTruthy();
    // Following no block list: nothing about them.
    expect(screen.queryByTestId('blocked-lists-note')).toBeNull();
    await act(async () => fireEvent.press(screen.getByTestId(`unblock-${BOB.id}`)));
    expect(fakeEngine.method('safety.unblock')).toHaveBeenCalledWith(BOB.id);
    expect(screen.queryByTestId(`blocked-${BOB.id}`)).toBeNull();
    expect(screen.getByTestId(`blocked-${AUTHORS.carol.id}`)).toBeTruthy();
  });

  it('shows a block made here before the engine lists it, and hides an unblock it still lists', async () => {
    fakeEngine.method('safety.blocked').mockResolvedValue({ items: [blocked[1]], cursor: null, hasMore: false });
    fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
    fakeEngine.method('safety.unblock').mockResolvedValue(ticket({ op: 'unblock' }));
    await act(async () =>
      sendWrite(blockWrite, {
        viewerId: VIEWER_ID,
        userId: BOB.id,
        block: true,
        message: 'Spam',
        user: { username: 'bob', displayName: BOB.displayName, avatar: BOB.avatar },
      }),
    );
    await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: AUTHORS.carol.id, block: false }));
    withProviders(<BlockedAccountsScreen />);
    await settle();

    expect(screen.getByTestId(`blocked-${BOB.id}`)).toBeTruthy();
    expect(screen.getByText('Spam')).toBeTruthy();
    expect(screen.queryByTestId(`blocked-${AUTHORS.carol.id}`)).toBeNull();
  });

  it('drops the own block after STILL_BLOCKED, while the posts stay hidden', async () => {
    // The engine's cached list still has bob after the unblock deleted the own block.
    fakeEngine.method('safety.blocked').mockResolvedValue({ items: blocked, cursor: null, hasMore: false });
    const pending = ticket({ op: 'unblock', target: { identityId: BOB.id } });
    fakeEngine.method('safety.unblock').mockResolvedValue(pending);
    queryClient.setQueryData(queryKeys.feed.home({ tab: 'forYou' }), [fixturePost({ id: 'b1' })]);
    withProviders(
      <>
        <BlockedAccountsScreen />
        <CachedList />
      </>,
    );
    await settle();
    await act(async () => fireEvent.press(screen.getByTestId(`unblock-${BOB.id}`)));
    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          error: { code: 'STILL_BLOCKED', consensusCode: null, outcome: 'local', retryable: false, userMessage: 'x' },
        }),
      ),
    );
    await settle();

    expect(toastMessage()).toBe(copy.toast.stillBlocked);
    expect(screen.queryByTestId(`blocked-${BOB.id}`)).toBeNull();
    expect(screen.getByTestId(`blocked-${AUTHORS.carol.id}`)).toBeTruthy();
    expect(screen.queryByTestId('post-card-b1')).toBeNull();
  });

  it.each([
    [1, 'Also hidden by 1 block list you follow ·'],
    [3, 'Also hidden by 3 block lists you follow ·'],
  ])('mentions the %s block lists the viewer follows, with where to manage them', async (lists, note) => {
    fakeEngine.method('safety.blocked').mockResolvedValue({ items: blocked, cursor: null, hasMore: false });
    fakeEngine.method('safety.followedBlockLists').mockResolvedValue(lists);
    withProviders(<BlockedAccountsScreen />);
    await settle();
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.getByText('Manage on yap.pr')).toBeTruthy();
  });

  it('says nothing about block lists to someone who follows none', async () => {
    fakeEngine.method('safety.blocked').mockResolvedValue({ items: blocked, cursor: null, hasMore: false });
    fakeEngine.method('safety.followedBlockLists').mockResolvedValue(0);
    withProviders(<BlockedAccountsScreen />);
    await settle();
    expect(screen.queryByTestId('blocked-lists-note')).toBeNull();
    expect(screen.queryByText(/block list/)).toBeNull();
  });

  it('says when nobody is blocked', async () => {
    fakeEngine.method('safety.blocked').mockResolvedValue({ items: [], cursor: null, hasMore: false });
    withProviders(<BlockedAccountsScreen />);
    await settle();
    expect(screen.getByText("You haven't blocked anyone")).toBeTruthy();
  });
});
