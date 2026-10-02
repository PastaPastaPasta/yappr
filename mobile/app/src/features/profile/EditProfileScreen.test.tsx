import type { CapabilitiesDTO, PostDTO, ProfileDTO, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactElement } from 'react';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { BookmarksScreen } from './BookmarksScreen';
import { EditProfileScreen } from './EditProfileScreen';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
// Stack.Screen renders its header buttons here, so the tests can press them.
jest.mock('expo-router', () => {
  const { View } = jest.requireActual('react-native');
  return {
    router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
    Stack: {
      Screen: ({ options }: { options?: { headerLeft?: () => ReactElement; headerRight?: () => ReactElement } }) => (
        <View>
          {options?.headerLeft?.()}
          {options?.headerRight?.()}
        </View>
      ),
    },
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
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

  it('shows the empty state', async () => {
    fakeEngine.method('engage.bookmarks').mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderScreen(<BookmarksScreen />);
    await flush();
    expect(screen.getByText('Save posts for later')).toBeTruthy();
    expect(alert).toBeNull();
  });
});
