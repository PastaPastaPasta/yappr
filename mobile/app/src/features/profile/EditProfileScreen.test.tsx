import type { CapabilitiesDTO, PostDTO, ProfileDTO, SessionDTO, WriteTicket } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactElement } from 'react';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { BookmarksScreen } from './BookmarksScreen';
import { EditProfileScreen } from './EditProfileScreen';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
/** The screen's navigation listeners (`beforeRemove`), so a test can try to leave. */
const mockListeners: Record<string, (event: unknown) => void> = {};

/** Tries to leave the screen; true when the screen held it back to ask. */
function tryLeave(): boolean {
  const preventDefault = jest.fn();
  act(() => mockListeners.beforeRemove?.({ preventDefault, data: { action: { type: 'GO_BACK' } } }));
  return preventDefault.mock.calls.length > 0;
}

// Stack.Screen renders its title and header buttons here, so the tests can read and press them.
jest.mock('expo-router', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
    Stack: {
      Screen: ({
        options,
      }: {
        options?: { title?: string; headerLeft?: () => ReactElement; headerRight?: () => ReactElement };
      }) => (
        <View>
          <Text testID="screen-title">{options?.title}</Text>
          {options?.headerLeft?.()}
          {options?.headerRight?.()}
        </View>
      ),
    },
    useNavigation: () => ({
      addListener: (event: string, listener: (e: unknown) => void) => {
        mockListeners[event] = listener;
        return () => undefined;
      },
      dispatch: jest.fn(),
    }),
    useFocusEffect: jest.fn(),
  };
});
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
const viewer: SessionDTO = {
  identityId: VIEWER,
  network: 'devnet',
  username: 'jana',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};
const PROFILE: ProfileDTO = {
  id: VIEWER,
  username: 'jana',
  usernames: ['jana'],
  displayName: 'Jana Abara',
  avatar: { uri: null, dicebear: { style: 'thumbs', seed: VIEWER } },
  hasProfile: true,
  bio: 'Film mostly.',
  stats: { posts: 1, followers: 3, following: 7 },
};

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

function renderScreen(element: ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterEach(() => queryClient.clear());

let alert: { title: string; press: (text: string) => void } | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  // A write a test left pending would keep its key busy for the next.
  resetWriteTracking();
  queryClient.clear();
  fakeEngine.setStatus({
    state: 'ready',
    info: {
      capabilities: {
        profileLimits: { displayName: 25, bio: 140 },
        dashpayProfile: true,
        repostable: { post: true, reply: true },
        bookmarkable: { post: true, reply: false },
      } as CapabilitiesDTO,
      avatarStyles: { styles: [{ id: 'thumbs', label: 'Thumbs' }], defaultStyle: 'thumbs', seedMaxLength: 64 },
    },
  });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useToastStore.setState({ current: null });
  alert = null;
  jest.spyOn(Alert, 'alert').mockImplementation((title, _message, buttons?: AlertButton[]) => {
    alert = { title, press: (text) => buttons?.find((b) => b.text === text)?.onPress?.() };
  });
});

describe('EditProfileScreen', () => {
  it('shows the retry state, not the form, when the read of a stale copy fails', async () => {
    // A copy persisted ten minutes ago, then the read this screen makes fails.
    queryClient.setQueryData(queryKeys.profile.detail(VIEWER), PROFILE, { updatedAt: Date.now() - 600_000 });
    fakeEngine.method('profiles.get').mockRejectedValue(new Error('offline'));
    renderScreen(<EditProfileScreen />);
    await flush();

    expect(fakeEngine.method('profiles.get')).toHaveBeenCalled();
    expect(screen.queryByText('DashPay profile')).toBeNull();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('groups the DashPay fields, saves only the change, and closes once confirmed', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();

    expect(screen.getByText('DashPay profile')).toBeTruthy();
    expect(screen.getByText('This also updates your DashPay profile, which other Dash apps show.')).toBeTruthy();
    expect(screen.getByTestId('edit-save')).toBeDisabled();

    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    expect(screen.getByTestId('edit-save')).toBeEnabled();
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    expect(fakeEngine.method('profiles.update')).toHaveBeenCalledWith({ pronouns: 'she/her' });
    expect(screen.getByTestId('edit-saving')).toBeTruthy();

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(useToastStore.getState().current?.message).toBe('Profile updated!');
    expect(router.back).toHaveBeenCalled();
  });

  it('keeps the form as it was while saving in the render that closes it (Android crash, profile-save-crash-dark)', async () => {
    // Re-enabling the fields as the modal closes moved the inputs between native parents inside
    // a screen Android was animating out: "addViewAt: … The specified child already has a parent".
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    const fields = ['edit-name', 'edit-bio', 'edit-pronouns', 'edit-location', 'edit-website', 'edit-banner'];
    for (const id of fields) expect(screen.getByTestId(id)).toBeDisabled();

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(router.back).toHaveBeenCalled();
    for (const id of fields) expect(screen.getByTestId(id)).toBeDisabled();
    expect(screen.getByTestId('edit-saving')).toBeTruthy();
    expect(screen.queryByTestId('edit-save')).toBeNull();
    expect(screen.getByTestId('edit-cancel')).toBeDisabled();
  });

  it('counts the two documents a dev save writes in the title: "Saving… (1 of 2)" (D-L3a-006)', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Edit profile');

    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    // Before the engine has said how many documents the save writes.
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Saving…', { exact: true });

    act(() => fakeEngine.emit('write.status', advance(pending, { progress: { done: 0, total: 2 } })));
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Saving… (1 of 2)');
    act(() => fakeEngine.emit('write.status', advance(pending, { progress: { done: 1, total: 2 } })));
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Saving… (2 of 2)');
  });

  it('says just "Saving…" for a save that writes one document', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    act(() => fakeEngine.emit('write.status', advance(pending, { progress: { done: 0, total: 1 } })));
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Saving…', { exact: true });
  });

  it('sends one update for a double-tapped Save, even after the first confirms (SR-14)', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    let answer: (t: typeof pending) => void = () => undefined;
    fakeEngine.method('profiles.update').mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    // Both taps land before the engine answers with the first ticket.
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-save'));
      fireEvent.press(screen.getByTestId('edit-save'));
    });
    await act(async () => answer(pending));
    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    await flush();
    expect(fakeEngine.method('profiles.update')).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding an edit', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    renderScreen(<EditProfileScreen />);
    await flush();
    expect(tryLeave()).toBe(false);
    fireEvent.changeText(screen.getByTestId('edit-bio'), 'Film and food.');
    expect(tryLeave()).toBe(true);
    expect(alert?.title).toBe('Discard changes?');
  });

  it('without a profile document: leaves without asking, and the first save creates it', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue({ ...PROFILE, hasProfile: false, displayName: 'jana', bio: undefined });
    fakeEngine.method('profiles.update').mockResolvedValue(ticket({ op: 'profile.update', target: { identityId: VIEWER } }));
    renderScreen(<EditProfileScreen />);
    await flush();

    expect(screen.getByTestId('edit-name')).toHaveDisplayValue('jana');
    expect(tryLeave()).toBe(false);
    expect(alert).toBeNull();
    expect(screen.getByTestId('edit-save')).toBeEnabled();
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));
    expect(fakeEngine.method('profiles.update')).toHaveBeenCalledWith({ displayName: 'jana' });
  });

  it('closes on an unconfirmed save rather than offering Save again', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    const pending = ticket({ op: 'profile.update', target: { identityId: VIEWER } });
    fakeEngine.method('profiles.update').mockResolvedValue(pending);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-pronouns'), 'she/her');
    await act(async () => fireEvent.press(screen.getByTestId('edit-save')));

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'unconfirmed' })));
    expect(router.back).toHaveBeenCalled();
    expect(useToastStore.getState().current?.message).not.toBe('Profile updated!');
  });

  it('blocks saving an over-long name', async () => {
    fakeEngine.method('profiles.get').mockResolvedValue(PROFILE);
    renderScreen(<EditProfileScreen />);
    await flush();
    fireEvent.changeText(screen.getByTestId('edit-name'), 'x'.repeat(26));
    expect(screen.getByText('At most 25 characters')).toBeTruthy();
    expect(screen.getByTestId('edit-save')).toBeDisabled();
  });
});

describe('BookmarksScreen', () => {
  const saved = (id: string, content: string): PostDTO =>
    fixturePost({ id, content, viewer: { ...fixturePost().viewer!, bookmarked: true } });
  const unbookmarkTicket = (id: string) => ticket({ op: 'unbookmark', target: { id, kind: 'post', ownerId: 'x', rootPostId: null } });
  /** Issues a pending ticket, then reports it as `settle` once the call has answered, as the engine does. */
  const unbookmarkThen = (settle: Partial<WriteTicket>) => async (target: { id: string }) => {
    const issued = unbookmarkTicket(target.id);
    setTimeout(() => fakeEngine.emit('write.status', advance(issued, settle)), 0);
    return issued;
  };

  it('lists bookmarks and drops one as soon as it is removed', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine.method('engage.unbookmark').mockResolvedValue(ticket({ op: 'unbookmark', target: { id: 'b1', kind: 'post', ownerId: 'x', rootPostId: null } }));
    renderScreen(<BookmarksScreen />);
    await flush();

    expect(screen.getByText('Film grain')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('bookmark-btn-b1')));
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
    expect(screen.queryByText('Film grain')).toBeNull();
    expect(screen.getByText('Salt is not optional')).toBeTruthy();
    expect(queryClient.getQueryData(queryKeys.bookmarks)).toBeDefined();
  });

  it('clears every bookmark, one write at a time, after confirming', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine.method('engage.unbookmark').mockImplementation(unbookmarkThen({ state: 'confirmed' }));
    renderScreen(<BookmarksScreen />);
    await flush();

    fireEvent(screen.getByTestId('bookmarks-menu'), 'pressAction', { nativeEvent: { event: 'clear' } });
    expect(alert?.title).toBe('Clear all bookmarks?');
    await act(async () => alert?.press('Clear all'));
    await flush();
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().current?.message).toBe('All bookmarks cleared');
    expect(screen.queryByText('Film grain')).toBeNull();
  });

  it('stops clearing at the first refusal and says how far it got', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional'), saved('b3', 'Kiln day')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine
      .method('engage.unbookmark')
      .mockImplementationOnce(unbookmarkThen({ state: 'unconfirmed' }))
      .mockRejectedValue(Object.assign(new Error('Not enough credits'), { code: 'FEE_UNPAYABLE' }));
    renderScreen(<BookmarksScreen />);
    await flush();

    fireEvent(screen.getByTestId('bookmarks-menu'), 'pressAction', { nativeEvent: { event: 'clear' } });
    await act(async () => alert?.press('Clear all'));
    await flush();
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().current?.message).toBe('Removed 1 of 3 bookmarks');
    expect(screen.getByText('Kiln day')).toBeTruthy();
  });

  it('waits for each removal to settle and stops at one that fails later', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine.method('engage.unbookmark').mockImplementation(async (target: { id: string }) => unbookmarkTicket(target.id));
    renderScreen(<BookmarksScreen />);
    await flush();

    fireEvent(screen.getByTestId('bookmarks-menu'), 'pressAction', { nativeEvent: { event: 'clear' } });
    await act(async () => alert?.press('Clear all'));
    await flush();
    // The first removal is still pending: the second waits.
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('bookmarks-clearing')).toBeTruthy();

    const issued = await fakeEngine.method('engage.unbookmark').mock.results[0]!.value;
    act(() => fakeEngine.emit('write.status', advance(issued, { state: 'failed' })));
    await flush();
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().current?.message).toBe('Removed 0 of 2 bookmarks');
    expect(screen.getByText('Film grain')).toBeTruthy();
  });

  it('offers to load more when a later page fails', async () => {
    fakeEngine
      .method('engage.bookmarks')
      .mockResolvedValueOnce({ items: [saved('b1', 'Film grain')], cursor: 'c1', hasMore: true })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ items: [saved('b2', 'Kiln day')], cursor: null, hasMore: false });
    renderScreen(<BookmarksScreen />);
    await flush();
    await act(async () => fireEvent(screen.getByTestId('bookmarks-list'), 'endReached'));
    await flush();
    // The failed page stops paging; the footer offers it again.
    expect(screen.getByText('Film grain')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('bookmarks-load-more')));
    await flush();
    expect(screen.getByText('Kiln day')).toBeTruthy();
    expect(screen.queryByTestId('bookmarks-load-more')).toBeNull();
  });

  it('removes a bookmark from the card menu, on both platforms (UX_SPEC 4.24, D-L3a-003)', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({
      items: [saved('b1', 'Film grain'), saved('b2', 'Salt is not optional')],
      cursor: null,
      hasMore: false,
    });
    fakeEngine.method('engage.unbookmark').mockResolvedValue(unbookmarkTicket('b1'));
    renderScreen(<BookmarksScreen />);
    await flush();

    const menu = screen.getByTestId('more-menu-b1');
    const items = (menu.props.actions as { id: string; title: string }[]).map((item) => item.title);
    expect(items.slice(items.indexOf('Share…'), items.indexOf('Share…') + 2)).toEqual(['Share…', 'Remove bookmark']);
    await act(async () => fireEvent(menu, 'pressAction', { nativeEvent: { event: 'remove-bookmark' } }));
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
    expect(useToastStore.getState().current?.message).toBe('Removed from bookmarks');
    expect(screen.queryByText('Film grain')).toBeNull();
    expect(screen.getByText('Salt is not optional')).toBeTruthy();
  });

  it("keeps a blocked author's bookmark as the blocked stub, never a blank list (G-6, G-7, D-L3i-003)", async () => {
    const blocked = fixturePost({
      id: 'b1',
      content: 'Film grain',
      viewer: { ...fixturePost().viewer!, bookmarked: true, authorBlocked: true },
    });
    fakeEngine.method('engage.bookmarks').mockResolvedValue({ items: [blocked], cursor: null, hasMore: false });
    renderScreen(<BookmarksScreen />);
    await flush();

    expect(screen.getByText('Post from an account you blocked')).toBeTruthy();
    expect(screen.queryByText('Film grain')).toBeNull();
    // Still removable, by its swipe action or its menu, which has nothing else.
    expect(screen.getByTestId('bookmark-remove-b1')).toBeTruthy();
    const menu = screen.getByTestId('more-menu-b1');
    expect((menu.props.actions as { title: string }[]).map((item) => item.title)).toEqual(['Remove bookmark']);
    expect(screen.getByTestId('stub-blocked').props.accessibilityActions).toEqual([{ name: 'more', label: 'More' }]);
    fakeEngine.method('engage.unbookmark').mockResolvedValue(unbookmarkTicket('b1'));
    await act(async () => fireEvent(menu, 'pressAction', { nativeEvent: { event: 'remove-bookmark' } }));
    expect(fakeEngine.method('engage.unbookmark')).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));
  });

  it('shows the empty state', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderScreen(<BookmarksScreen />);
    await flush();
    expect(screen.getByText('Save posts for later')).toBeTruthy();
    expect(alert).toBeNull();
  });
});
