import type { CapabilitiesDTO, ProfileDTO, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ActionSheetIOS } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useSignInPrompt } from '~/data/require-auth';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { resetBlockDecisions, useAuthorBlocked } from '~/features/safety/block-state';
import { useToastStore } from '~/ui/toast';

import { ProfileScreen } from './ProfileScreen';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true, replace: jest.fn() },
  Stack: { Screen: () => null },
  useFocusEffect: jest.fn(),
  useNavigation: () => ({ canGoBack: () => true, goBack: jest.fn() }),
}));
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
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

const VIEWER = 'as7CNcWaqWqJND2pxfnKjc6da6AhWVpsXGR92yraATc';
const OTHER = '53KCzjNSdd659otdCFWfKk46zPDuHzcn1LchBbNNHijz';

const viewer: SessionDTO = {
  identityId: VIEWER,
  network: 'devnet',
  username: 'jana',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};

const profile = (overrides: Partial<ProfileDTO> = {}): ProfileDTO => ({
  id: OTHER,
  username: 'sigrid',
  usernames: ['sigrid', 'sigrid-alt'],
  displayName: 'Sigrid Dahl',
  avatar: { uri: null, dicebear: { style: 'thumbs', seed: OTHER } },
  hasProfile: true,
  bio: 'Home cook.',
  location: 'Colombo',
  website: 'https://sigrid.dev',
  pronouns: 'she/her',
  joinedAt: new Date(2026, 9, 1),
  stats: { posts: 1, followers: 3, following: 4 },
  viewer: { follows: false, blocks: false, blockedBy: null, isSelf: false },
  ...overrides,
});

const emptyPage = { items: [], cursor: null, hasMore: false };

function renderProfile(idOrName = OTHER, props: { ownTab?: boolean } = {}) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <QueryClientProvider client={queryClient}>
        <ProfileScreen idOrName={idOrName} {...props} />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

/** Lets the reads resolve and FlashList finish its layout pass (it measures on a timer). */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
// Unanswered reads would otherwise keep retrying (and Jest from exiting).
afterEach(() => queryClient.clear());

let sheet: { options: string[]; choose: (label: string) => void } | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  // A write a test left pending would keep its key busy for the next.
  resetWriteTracking();
  // A block decision a test made would hold for the next (features/safety).
  resetBlockDecisions();
  queryClient.clear();
  fakeEngine.setStatus({ info: { capabilities: { rankings: true } as CapabilitiesDTO } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useToastStore.setState({ current: null });
  useSignInPrompt.setState({ open: false });
  fakeEngine.method('settings.get').mockResolvedValue({ gateMediaFromNonFollowed: false, sensitiveContentMode: 'blur' });
  fakeEngine.method('profiles.posts').mockResolvedValue(emptyPage);
  sheet = null;
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
    const labels = options.options;
    sheet = { options: labels, choose: (label) => callback(labels.indexOf(label)) };
  });
});

describe('ProfileScreen', () => {
  it('shows the header: name, handle, pronouns, bio, meta, counts and aliases', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profile());
    renderProfile();
    await flush();

    expect(screen.getByTestId('profile-name')).toHaveTextContent('Sigrid Dahl');
    expect(screen.getByTestId('profile-handle')).toHaveTextContent('@sigrid');
    expect(screen.getByText('· she/her')).toBeTruthy();
    expect(screen.getByText('Home cook.')).toBeTruthy();
    expect(screen.getByText('Colombo')).toBeTruthy();
    expect(screen.getByTestId('profile-website')).toHaveTextContent('sigrid.dev');
    expect(screen.getByText('Joined Oct 2026')).toBeTruthy();
    expect(screen.getByText('Also known as @sigrid-alt')).toBeTruthy();
    expect(screen.getByLabelText('3 Followers')).toBeTruthy();
    expect(screen.getByLabelText('Message Sigrid Dahl')).toBeTruthy();
    expect(screen.getByTestId('profile-tabs-top')).toBeTruthy();
    expect(fakeEngine.method('profiles.posts')).toHaveBeenCalledWith({ id: OTHER, tab: 'posts', cursor: null });
    expect(await screen.findByText('No original posts yet')).toBeTruthy();
  });

  it('follows at once, and asks before unfollowing', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profile());
    const pending = ticket({ op: 'follow', target: { identityId: OTHER } });
    fakeEngine.method('graph.follow').mockResolvedValue(pending);
    renderProfile();
    await flush();

    await act(async () => fireEvent.press(screen.getByTestId('profile-follow')));
    expect(fakeEngine.method('graph.follow')).toHaveBeenCalledWith(OTHER);
    expect(screen.getByTestId('profile-follow')).toHaveAccessibleName('Following Sigrid Dahl');
    expect(screen.getByLabelText('4 Followers')).toBeTruthy();
    expect(useToastStore.getState().current?.message).toBe('Following!');
    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));

    fakeEngine.method('graph.unfollow').mockResolvedValue(ticket({ op: 'unfollow', target: { identityId: OTHER } }));
    fireEvent.press(screen.getByTestId('profile-follow'));
    expect(sheet?.options).toEqual(['Unfollow', 'Cancel']);
    await act(async () => sheet?.choose('Unfollow'));
    expect(fakeEngine.method('graph.unfollow')).toHaveBeenCalledWith(OTHER);
    expect(screen.getByTestId('profile-follow')).toHaveAccessibleName('Follow Sigrid Dahl');
    expect(screen.getByLabelText('3 Followers')).toBeTruthy();
  });

  it('rolls the follow back when the write is refused', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profile());
    fakeEngine.method('graph.follow').mockRejectedValue(Object.assign(new Error('Not enough credits'), { code: 'FEE_UNPAYABLE' }));
    renderProfile();
    await flush();

    await act(async () => fireEvent.press(screen.getByTestId('profile-follow')));
    await flush();
    expect(fakeEngine.method('graph.follow')).toHaveBeenCalledWith(OTHER);
    expect(screen.getByTestId('profile-follow')).toHaveAccessibleName('Follow Sigrid Dahl');
    expect(screen.getByLabelText('3 Followers')).toBeTruthy();
  });

  it('asks a signed-out reader to sign in instead of following', async () => {
    useSessionStore.setState({ status: 'signed-out', session: null });
    fakeEngine.method('profiles.get').mockResolvedValue(profile({ viewer: undefined }));
    renderProfile();
    await flush();
    fireEvent.press(screen.getByTestId('profile-follow'));
    expect(fakeEngine.method('graph.follow')).not.toHaveBeenCalled();
    expect(useSignInPrompt.getState().open).toBe(true);
  });

  it('replaces the tabs with the blocked notice, and unblocks optimistically', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profile({ viewer: { follows: false, blocks: true, blockedBy: 'self', isSelf: false } }));
    fakeEngine.method('safety.unblock').mockResolvedValue(ticket({ op: 'unblock', target: { identityId: OTHER } }));
    renderProfile();
    await flush();

    expect(screen.getByText('You blocked this user')).toBeTruthy();
    expect(screen.queryByTestId('profile-tabs')).toBeNull();
    expect(screen.queryByLabelText('Message Sigrid Dahl')).toBeNull();
    expect(fakeEngine.method('profiles.posts')).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(screen.getByText('Unblock')));
    expect(fakeEngine.method('safety.unblock')).toHaveBeenCalledWith(OTHER);
    expect(screen.queryByText('You blocked this user')).toBeNull();
    expect(screen.getByTestId('profile-tabs')).toBeTruthy();
    // The shared unblock (features/safety): the author's posts come back everywhere else too.
    expect(renderHook(() => useAuthorBlocked(OTHER, true)).result.current).toBe(false);
  });

  it('brings the blocked notice back when the unblock is refused (a followed block list)', async () => {
    const blocked = profile({ viewer: { follows: false, blocks: true, blockedBy: 'self', isSelf: false } });
    fakeEngine.method('profiles.get').mockResolvedValue(blocked);
    fakeEngine
      .method('safety.unblock')
      .mockRejectedValue(Object.assign(new Error('Blocked through a block list you follow'), { code: 'STILL_BLOCKED' }));
    renderProfile();
    await flush();

    await act(async () => fireEvent.press(screen.getByText('Unblock')));
    await flush();
    expect(fakeEngine.method('safety.unblock')).toHaveBeenCalledWith(OTHER);
    expect(screen.getByText('You blocked this user')).toBeTruthy();
    expect(screen.queryByTestId('profile-tabs')).toBeNull();
  });

  it('treats the Profile tab as the viewer’s own while the session restores', async () => {
    useSessionStore.setState({ status: 'unknown', session: null, accounts: [] });
    fakeEngine.method('profiles.get').mockResolvedValue(
      profile({ id: VIEWER, username: 'jana', displayName: 'Jana Abara', viewer: undefined }),
    );
    renderProfile(VIEWER, { ownTab: true });
    await flush();

    expect(screen.getByTestId('profile-edit')).toBeTruthy();
    expect(screen.getByTestId('profile-settings')).toBeTruthy();
    expect(screen.queryByTestId('profile-follow')).toBeNull();
    expect(screen.queryByLabelText('Message Jana Abara')).toBeNull();
  });

  it('shows the own profile with Edit profile and the username card when nameless', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(
      profile({ id: VIEWER, username: null, usernames: [], hasProfile: false, displayName: 'User yraATc', viewer: { follows: false, blocks: false, blockedBy: null, isSelf: true } }),
    );
    renderProfile(VIEWER, { ownTab: true });
    await flush();

    fireEvent.press(screen.getByTestId('profile-edit'));
    expect(router.push).toHaveBeenCalledWith('/profile/edit');
    expect(screen.queryByTestId('profile-follow')).toBeNull();
    // Nameless: the truncated id is the name, and copies.
    expect(screen.getByTestId('profile-copy-id')).toBeTruthy();
    expect(screen.getByText('Get a username')).toBeTruthy();
    fireEvent.press(screen.getByTestId('username-card-dismiss'));
    expect(screen.queryByText('Get a username')).toBeNull();
  });

  it('gates an NSFW profile behind the interstitial', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profile({ nsfw: true }));
    renderProfile();
    await flush();
    expect(screen.getByText('This profile may contain adult content')).toBeTruthy();
    expect(screen.queryByTestId('profile-header')).toBeNull();
    fireEvent.press(screen.getByTestId('profile-nsfw-view'));
    expect(screen.getByTestId('profile-header')).toBeTruthy();
  });

  it('says when a user does not exist, and when an id is invalid', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(null);
    renderProfile();
    await flush();
    expect(screen.getByText('User not found')).toBeTruthy();

    queryClient.clear();
    renderProfile('not/a valid id');
    await flush();
    expect(screen.getByText('Invalid identity ID')).toBeTruthy();
  });

  it('loads the tab picked, with each tab’s own empty state', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(profile());
    renderProfile();
    await flush();
    fireEvent.press(screen.getByTestId('profile-tabs-mentions'));
    await flush();
    expect(fakeEngine.method('profiles.posts')).toHaveBeenCalledWith({ id: OTHER, tab: 'mentions', cursor: null });
    expect(screen.getByText('No mentions yet')).toBeTruthy();
    expect(queryClient.getQueryData(queryKeys.profile.posts(OTHER, 'mentions'))).toBeDefined();
  });
});
