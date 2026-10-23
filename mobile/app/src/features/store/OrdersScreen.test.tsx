import type { SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionStore } from '~/data/session';
import { fakeEngine } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';

import { OrdersScreen } from './OrdersScreen';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  Stack: { Screen: () => null },
}));
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

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const viewer: SessionDTO = { identityId: 'viewer', network: 'devnet', username: 'alice', credits: 1n, hasEncryptionKey: true, method: 'key' };

async function renderOrders() {
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <OrdersScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await act(async () => {});
}

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());
beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
});

describe('OrdersScreen signed out (MUX-8)', () => {
  beforeEach(() => useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] }));

  it('asks to sign in instead of loading forever, and reads nothing', async () => {
    await renderOrders();

    expect(screen.getByText('Sign in to see your orders')).toBeTruthy();
    expect(screen.queryByTestId('orders-tabs')).toBeNull();
    expect(screen.queryByTestId('store-loading')).toBeNull();
    expect(fakeEngine.method('store.myOrders')).not.toHaveBeenCalled();
  });

  it('opens sign-in, which closes back to the orders, and the store browser', async () => {
    await renderOrders();

    fireEvent.press(screen.getByTestId('orders-signed-out-action'));
    expect(router.push).toHaveBeenLastCalledWith('/sign-in');
    fireEvent.press(screen.getByText('Browse stores'));
    expect(router.push).toHaveBeenLastCalledWith('/store');
  });

  it('shows the orders once the viewer signs in', async () => {
    await renderOrders();
    fakeEngine.method('store.myOrders').mockResolvedValue({ items: [], cursor: null, hasMore: false });

    await act(async () => useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] }));

    expect(screen.queryByText('Sign in to see your orders')).toBeNull();
    expect(screen.getByTestId('orders-tabs')).toBeTruthy();
    expect(screen.getByText('No orders yet')).toBeTruthy();
  });
});

describe('OrdersScreen while the session is restoring', () => {
  it('shows the loading state, not the sign-in prompt', async () => {
    useSessionStore.setState({ status: 'unknown', session: null, accounts: [] });
    await renderOrders();
    expect(screen.queryByText('Sign in to see your orders')).toBeNull();
    expect(screen.getByTestId('store-loading')).toBeTruthy();
  });
});
