import type { SessionDTO, Store, StoreManageDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking, submitWrite } from '~/data/writes';
import { queryClient } from '~/state/query-client';

import { StoreManageScreen } from './StoreManageScreen';
import { saveStoreWrite, STORE_SHOWS_RETRY_MS } from './store-writes';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  Stack: { Screen: () => null },
}));

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const viewer: SessionDTO = { identityId: 'viewer', network: 'devnet', username: 'alice', credits: 1n, hasEncryptionKey: true, method: 'key' };

const manage = (store: Store | null): StoreManageDTO => ({
  store,
  policies: [],
  items: [],
  zones: [],
  categoryRequired: true,
  supportsDigital: true,
  supportsItemZones: true,
  canTakeOrders: true,
  keyOnDevice: true,
});
const shop = { id: 'store1', ownerId: 'viewer', createdAt: new Date(0), name: 'Alice Goods', status: 'active', paymentUris: [] } as Store;

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.useFakeTimers();
  fakeEngine.reset();
  queryClient.clear();
  resetWriteTracking();
  fakeEngine.setStatus({ state: 'ready', info: {} });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
});

afterEach(() => jest.useRealTimers());

describe('creating a store (D-951)', () => {
  it('holds back a second create while one may land, and shows the store once the lagging read catches up', async () => {
    fakeEngine.method('store.manage').mockResolvedValue(manage(null));
    render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={queryClient}>
          <StoreManageScreen />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId('store-manage-empty-action')).toBeTruthy();

    const pending = ticket({ op: 'store.save', state: 'pending' });
    fakeEngine.method('store.saveStore').mockResolvedValue(pending);
    await act(async () => {
      await submitWrite(saveStoreWrite, { fields: { name: 'Alice Goods', category: 'books' } });
    });
    // While the create may still land, My store never offers "Create store" again.
    expect(screen.getByTestId('store-manage-creating')).toBeTruthy();
    expect(screen.queryByTestId('store-manage-empty-action')).toBeNull();

    // Confirmed, but the owner's-store read lags the chain twice before it shows the store.
    fakeEngine.method('store.manage').mockResolvedValueOnce(manage(null)).mockResolvedValueOnce(manage(null)).mockResolvedValue(manage(shop));
    await act(async () => {
      fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' }));
    });
    expect(screen.getByTestId('store-manage-creating')).toBeTruthy();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(STORE_SHOWS_RETRY_MS[0]);
    });
    expect(screen.getByTestId('store-manage-creating')).toBeTruthy();
    expect(screen.queryByTestId('store-manage-empty-action')).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(STORE_SHOWS_RETRY_MS[1]);
    });
    expect(screen.getByText('Alice Goods')).toBeTruthy();
    expect(screen.queryByTestId('store-manage-empty-action')).toBeNull();
  });
});
