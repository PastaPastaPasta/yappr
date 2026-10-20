import type { SessionDTO, Store, StoreManageDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking } from '~/data/writes';
import { queryClient } from '~/state/query-client';

import { StoreEditScreen } from './StoreEditScreen';

const focus = { current: true };
jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'store1' }),
  useNavigation: () => ({ isFocused: () => focus.current }),
}));

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const viewer: SessionDTO = { identityId: 'viewer', network: 'devnet', username: 'alice', credits: 1n, hasEncryptionKey: true, method: 'key' };
const shop = { id: 'store1', ownerId: 'viewer', createdAt: new Date(0), $revision: 3, name: 'Alice Goods', status: 'active', category: 'books', paymentUris: [] } as Store;
const manage: StoreManageDTO = {
  store: shop, policies: [], items: [], zones: [], categoryRequired: true, supportsDigital: true, supportsItemZones: true, canTakeOrders: true, keyOnDevice: true,
};

function renderEdit() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <StoreEditScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

async function saveStore() {
  const pending = ticket({ op: 'store.save', state: 'pending' });
  fakeEngine.method('store.saveStore').mockResolvedValue(pending);
  await act(async () => {
    fireEvent.press(screen.getByTestId('store-save'));
  });
  return pending;
}

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  focus.current = true;
  fakeEngine.reset();
  queryClient.clear();
  resetWriteTracking();
  fakeEngine.setStatus({ state: 'ready', info: {} });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  fakeEngine.method('store.manage').mockResolvedValue(manage);
});

describe('saving a store, then leaving (D-970)', () => {
  it('closes the form when its save lands while the seller is still on it', async () => {
    renderEdit();
    await act(async () => {});
    const pending = await saveStore();
    await act(async () => {
      fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' }));
    });
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('never navigates when the save lands after the seller went Back or to another tab', async () => {
    renderEdit();
    await act(async () => {});
    const pending = await saveStore();
    // Another screen is in front now (Back pressed, another tab chosen).
    focus.current = false;
    await act(async () => {
      fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' }));
    });
    expect(router.back).not.toHaveBeenCalled();
  });

  it('leaves nothing mounted when the form is unmounted during a pending save', async () => {
    const view = renderEdit();
    await act(async () => {});
    const pending = await saveStore();
    view.unmount();
    expect(view.toJSON()).toBeNull();
    await act(async () => {
      fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' }));
    });
    expect(router.back).not.toHaveBeenCalled();
  });
});
