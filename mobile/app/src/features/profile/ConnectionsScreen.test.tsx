import type { SessionDTO, UserSummaryDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionStore } from '~/data/session';
import { fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { useToastStore } from '~/ui/toast';

import { ConnectionsScreen } from './ConnectionsScreen';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

/** The screen's header options, so a test can type in the native search bar. */
let mockOptions: { headerSearchBarOptions?: { onChangeText?: (event: { nativeEvent: { text: string } }) => void } } = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
  Stack: {
    Screen: ({ options }: { options: typeof mockOptions }) => {
      mockOptions = options;
      return null;
    },
  },
  useFocusEffect: jest.fn(),
}));
jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => {
  const layout = { x: 0, y: 0, width: 400, height: 900 };
  return {
    ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
    measureParentSize: () => layout,
    measureFirstChildLayout: () => layout,
    measureItemLayout: () => ({ x: 0, y: 0, width: 400, height: 72 }),
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

const user = (id: string, username: string, displayName: string, viewerFollows = false): UserSummaryDTO => ({
  id,
  username,
  displayName,
  avatar: { uri: null, dicebear: { style: 'thumbs', seed: id } },
  resolved: true,
  viewerFollows,
});

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

const search = (text: string) =>
  act(() => mockOptions.headerSearchBarOptions?.onChangeText?.({ nativeEvent: { text } }));

function renderConnections(kind: 'followers' | 'following' = 'followers') {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <QueryClientProvider client={queryClient}>
        <ConnectionsScreen id={VIEWER} kind={kind} />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterEach(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  // A write a test left pending would keep its key busy for the next.
  resetWriteTracking();
  queryClient.clear();
  mockOptions = {};
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  useToastStore.setState({ current: null });
  fakeEngine.method('profiles.get').mockResolvedValue(null);
});

describe('ConnectionsScreen', () => {
  it('offers "Follow back" on the viewer’s own followers, and follows optimistically', async () => {
    const asha = user('Asha111111111111111111111111111111111111111', 'asha', 'Asha Rao');
    fakeEngine.method('graph.followers').mockResolvedValue({ items: [asha], cursor: null, hasMore: false });
    fakeEngine.method('graph.follow').mockResolvedValue(ticket({ op: 'follow', target: { identityId: asha.id } }));
    renderConnections();
    await flush();

    const button = screen.getByTestId(`user-row-${asha.id}-follow`);
    expect(button).toHaveAccessibleName('Follow back Asha Rao');
    await act(async () => fireEvent.press(button));
    expect(fakeEngine.method('graph.follow')).toHaveBeenCalledWith(asha.id);
    expect(screen.getByTestId(`user-row-${asha.id}-follow`)).toHaveAccessibleName('Following Asha Rao');
  });

  it('pages on while a search has no match yet, then says when nobody matches', async () => {
    // A long first page, so only the search (not the end of the list) asks for the next.
    const first = [user('A1', 'asha', 'Asha Rao'), ...Array.from({ length: 59 }, (_, i) => user(`F${i}`, `fan${i}`, `Fan ${i}`))];
    const second = [user('Z3', 'zedekiah', 'Zed Okafor')];
    fakeEngine
      .method('graph.followers')
      .mockImplementation(async (_id: string, cursor: string | null) =>
        cursor ? { items: second, cursor: null, hasMore: false } : { items: first, cursor: 'c1', hasMore: true },
      );
    renderConnections();
    await flush();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(screen.queryByText('Zed Okafor')).toBeNull();

    search('zed');
    await flush();
    expect(fakeEngine.method('graph.followers')).toHaveBeenCalledWith(VIEWER, 'c1');
    expect(screen.getByText('Zed Okafor')).toBeTruthy();
    expect(screen.queryByText('Asha Rao')).toBeNull();

    search('nobody');
    await flush();
    expect(screen.getByText('No users found with that name')).toBeTruthy();
  });

  it('shows the empty state for a list with nobody on it', async () => {
    fakeEngine.method('graph.following').mockResolvedValue({ items: [], cursor: null, hasMore: false });
    renderConnections('following');
    await flush();
    expect(screen.getByText('Not following anyone yet')).toBeTruthy();
  });
});
