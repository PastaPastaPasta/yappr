import type {
  BlockedUserDTO,
  CapabilitiesDTO,
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
import { Linking, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking, sendWrite } from '~/data/writes';
import { PostItem } from '~/features/post/PostItem';
import { queryClient } from '~/state/query-client';
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

function profileOf(blocks: boolean): ProfileDTO {
  return {
    id: BOB.id,
    username: 'bob',
    usernames: ['bob'],
    displayName: BOB.displayName,
    avatar: BOB.avatar,
    hasProfile: true,
    stats: { posts: 3, followers: 1, following: 2 },
    viewer: { follows: false, blocks, isSelf: false },
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

    await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }, copy.toast.blocked));
    expect(fakeEngine.method('safety.block')).toHaveBeenCalledWith(BOB.id, null);
    expect(screen.queryByTestId('post-card-b1')).toBeNull();
    expect(screen.queryByTestId('post-card-b2')).toBeNull();
    expect(screen.getByTestId('post-card-c1')).toBeTruthy();
    expect(toastMessage()).toBe('User blocked');

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
    expect(toastMessage()).toBe(copy.toast.blockFailed);
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

  it('forgets block decisions when the account changes, so the engine decides again', async () => {
    fakeEngine.method('safety.block').mockResolvedValue(ticket({ op: 'block' }));
    renderPosts(bobPosts());
    await act(async () => sendWrite(blockWrite, { viewerId: VIEWER_ID, userId: BOB.id, block: true }));
    expect(screen.queryByTestId('post-card-b1')).toBeNull();

    // Signed out, then back in: an unblock made elsewhere meanwhile shows (the cached posts say not blocked).
    act(() => useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] }));
    act(() => useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] }));
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
    expect(screen.getByText(copy.block.noteHint)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('block-note'), '  spam bot  ');
    await act(async () => fireEvent.press(screen.getByTestId('block-confirm')));

    expect(fakeEngine.method('safety.block')).toHaveBeenCalledWith(BOB.id, { message: 'spam bot' });
    expect(router.back).toHaveBeenCalled();
    expect(toastMessage()).toBe('User blocked');
  });

  it('offers Unblock for an account already blocked', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profileOf(true));
    fakeEngine.method('safety.unblock').mockResolvedValue(ticket({ op: 'unblock' }));
    withProviders(<BlockScreen />);
    await settle();

    expect(screen.getByText('You blocked @bob')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('unblock-confirm')));
    expect(fakeEngine.method('safety.unblock')).toHaveBeenCalledWith(BOB.id);
    expect(toastMessage()).toBe('User unblocked');
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

  beforeEach(() => {
    params.mockReturnValue({ postId: 'p1', kind: 'post' });
    fakeEngine.method('posts.get').mockResolvedValue(post);
  });

  it('files a report with its reason and note, then offers to block', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target: { id: 'p1', kind: 'post', ownerId: BOB.id, rootPostId: null } });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    withProviders(<ReportScreen />);
    await settle();

    expect(screen.getByText(/You can come back here to see how the moderators resolved it/)).toBeTruthy();
    expect(screen.getByTestId('report-submit')).toBeDisabled();
    fireEvent.press(screen.getByTestId('report-reason-8'));
    expect(screen.getByText('Details (required)')).toBeTruthy();
    expect(screen.getByTestId('report-submit')).toBeDisabled();
    fireEvent.changeText(screen.getByTestId('report-note'), 'Phishing link');
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));

    expect(fakeEngine.method('safety.report')).toHaveBeenCalledWith(
      { id: 'p1', kind: 'post', ownerId: BOB.id, rootPostId: null },
      8,
      'Phishing link',
    );
    expect(screen.getByText('Reporting…')).toBeTruthy();

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(screen.getByTestId('report-sent')).toBeTruthy();
    // The sheet says it; no toast on top.
    expect(toastMessage()).toBeUndefined();
    fireEvent.press(screen.getByTestId('report-also-block'));
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/block/[userId]', params: { userId: BOB.id } });
  });

  it('sends one report for a double tap, and toasts a confirmation that lands after the sheet closed', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target: { id: 'p1', kind: 'post', ownerId: BOB.id, rootPostId: null } });
    let answer: (value: typeof pending) => void = () => undefined;
    fakeEngine.method('safety.report').mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { unmount } = withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    fireEvent.press(screen.getByTestId('report-submit'));
    fireEvent.press(screen.getByTestId('report-submit'));
    await act(async () => answer(pending));
    expect(fakeEngine.method('safety.report')).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(toastMessage()).toBe('Report sent');
    // Nothing was queued behind the first report to go out now.
    expect(fakeEngine.method('safety.report')).toHaveBeenCalledTimes(1);
  });

  it('follows a report still on its way when the sheet is dismissed and reopened, and sends no second one', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target: { id: 'p1', kind: 'post', ownerId: BOB.id, rootPostId: null } });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    const first = withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    first.unmount();

    withProviders(<ReportScreen />);
    await settle();
    // The reopened sheet shows the first report going out, not a fresh form.
    expect(screen.getByText('Reporting…')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(screen.getByTestId('report-sent')).toBeTruthy();
    expect(toastMessage()).toBeUndefined();
    expect(fakeEngine.method('safety.report')).toHaveBeenCalledTimes(1);
  });

  it('drops a report sent from a reopened sheet before the first one has its ticket', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report', target: { id: 'p1', kind: 'post', ownerId: BOB.id, rootPostId: null } });
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

  it('checks again before offering the form over a cached "no report"', async () => {
    queryClient.setQueryData(queryKeys.post.ownReport('p1'), null);
    fakeEngine.method('safety.ownReport').mockReturnValue(new Promise(() => undefined));
    withProviders(<ReportScreen />);
    await settle();
    expect(screen.getByTestId('report-checking')).toBeTruthy();
    expect(screen.queryByTestId('report-submit')).toBeNull();
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
    expect(screen.getByTestId('report-gone')).toBeTruthy();
  });

  it('shows an existing report instead of the form', async () => {
    const report: OwnReportDTO = {
      id: 'r1',
      reason: 0,
      note: 'Same link everywhere',
      createdAt: new Date('2026-09-30T12:00:00Z'),
      status: 2,
      resolution: null,
      moderatedAt: new Date('2026-10-01T12:00:00Z'),
    };
    fakeEngine.method('safety.ownReport').mockResolvedValue(report);
    withProviders(<ReportScreen />);
    await settle();

    expect(screen.getByText(/you reported it for Spam or scam/)).toBeTruthy();
    expect(screen.getByText('Same link everywhere')).toBeTruthy();
    expect(screen.getByText(/Resolved by the moderators: Content removed/)).toBeTruthy();
    expect(screen.queryByTestId('report-submit')).toBeNull();
  });

  it('never offers a second report when the check fails', async () => {
    fakeEngine.method('safety.ownReport').mockRejectedValue(new Error('unavailable'));
    withProviders(<ReportScreen />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(screen.getByTestId('report-check-failed')).toBeTruthy();
    expect(screen.queryByTestId('report-submit')).toBeNull();
  });

  it('offers email when the moderation team is not seated yet', async () => {
    fakeEngine.method('safety.ownReport').mockResolvedValue(null);
    const pending = ticket({ op: 'report' });
    fakeEngine.method('safety.report').mockResolvedValue(pending);
    withProviders(<ReportScreen />);
    await settle();
    fireEvent.press(screen.getByTestId('report-reason-0'));
    await act(async () => fireEvent.press(screen.getByTestId('report-submit')));
    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          error: {
            code: 'MODERATION_NOT_SEATED',
            consensusCode: null,
            outcome: 'refused',
            retryable: false,
            userMessage: 'x',
          },
        }),
      ),
    );
    expect(screen.getByText(copy.report.notSeated, { exact: false })).toBeTruthy();
    expect(screen.getByTestId('report-email-send')).toBeTruthy();
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
    await act(async () => fireEvent.press(screen.getByTestId('report-email-send')));

    const url = openURL.mock.calls[0]?.[0] ?? '';
    expect(url).toMatch(/^mailto:support@yap\.pr\?subject=Report%3A%20post%20p1&body=/);
    expect(decodeURIComponent(url)).toContain('/post?id=p1\n\nReason: ');
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(expect.stringContaining('support@yap.pr'));
    expect(toastMessage()).toBe(copy.toast.reportCopied);
    expect(fakeEngine.method('safety.report')).not.toHaveBeenCalled();
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
    expect(screen.getByText(copy.blocked.listsNote)).toBeTruthy();
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

  it('says when nobody is blocked', async () => {
    fakeEngine.method('safety.blocked').mockResolvedValue({ items: [], cursor: null, hasMore: false });
    withProviders(<BlockedAccountsScreen />);
    await settle();
    expect(screen.getByText("You haven't blocked anyone")).toBeTruthy();
  });
});
