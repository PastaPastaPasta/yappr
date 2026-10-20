import type { CheckoutQuoteDTO, SessionDTO, ShippingAddress } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSessionStore } from '~/data/session';
import { fakeEngine } from '~/data/testing/fake-engine';
import { resetWriteTracking } from '~/data/writes';
import { queryKeys } from '~/data/keys';
import { describeQueryKey, queryClient } from '~/state/query-client';

import { CheckoutScreen } from './CheckoutScreen';
import { FormScroll } from './parts';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ storeId: 'store1' }),
}));
// The QR code as the value it encodes.
jest.mock('react-native-qrcode-svg', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return function QRCode({ value }: { value: string }) {
    return <RNText testID="qr-value">{value}</RNText>;
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const viewer: SessionDTO = { identityId: 'viewer', network: 'devnet', username: 'alice', credits: 1n, hasEncryptionKey: true, method: 'key' };
const PAY = 'dash:yLadnCajwhccmjsUS1Bm2icVv5ehdeFtxj';

const quote = (shipTo: ShippingAddress | null): CheckoutQuoteDTO => ({
  store: { id: 'store1', name: 'Alice Goods', ownerId: 'seller', policies: [], paymentUris: [{ scheme: 'dash:', uri: PAY }] },
  lines: [{ key: 'mug', itemId: 'mug', storeId: 'store1', title: 'Mug', quantity: 1, unitPrice: 1200, currency: 'USD', digital: false }],
  unavailable: [],
  currency: 'USD',
  digitalCount: 0,
  digitalOnly: false,
  subtotal: 1200,
  // The seller's zone prices it once there is an address.
  shipping: shipTo ? { state: 'ok', cost: 700, problem: null, shipments: [{ zone: 'US', cost: 700, titles: ['Mug'] }] } : { state: 'none', cost: 0, problem: null, shipments: [] },
  total: shipTo ? 1900 : 1200,
  blocker: null,
  blockerMessage: null,
  orderSizeError: null,
  paymentFieldLimits: null,
});

function renderCheckout() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <CheckoutScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  fakeEngine.reset();
  queryClient.clear();
  resetWriteTracking();
  fakeEngine.setStatus({ state: 'ready', info: {} });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  fakeEngine.method('store.checkout').mockImplementation(async ({ shipTo }: { shipTo: ShippingAddress | null }) => quote(shipTo));
});

async function fillAddress() {
  fireEvent.changeText(screen.getByTestId('addr-name'), 'Ann Buyer');
  fireEvent.changeText(screen.getByTestId('addr-street'), '1 Main St');
  fireEvent.changeText(screen.getByTestId('addr-city'), 'Springfield');
  fireEvent.changeText(screen.getByTestId('addr-postal'), '12345');
  await act(async () => {
    fireEvent.press(screen.getByTestId('checkout-continue'));
  });
}

describe('checkout', () => {
  it('asks a cart with something to ship for an address, and prices shipping under the seller zones (D-953)', async () => {
    renderCheckout();
    await act(async () => {});
    expect(screen.queryByTestId('checkout-ship')).toBeNull();
    expect(screen.getByTestId('addr-name')).toBeTruthy();

    // No address: it stays on the details step.
    await act(async () => {
      fireEvent.press(screen.getByTestId('checkout-continue'));
    });
    expect(screen.getByTestId('checkout-details')).toBeTruthy();

    await fillAddress();
    expect(fakeEngine.method('store.checkout')).toHaveBeenLastCalledWith(expect.objectContaining({ shipTo: expect.objectContaining({ city: 'Springfield', country: 'US' }) }));
    expect(screen.getByText('Shipping: $7.00')).toBeTruthy();
    expect(screen.queryByText('Shipping: Free')).toBeNull();
  });

  it('shows the DASH amount and asks for it in the QR code (D-952)', async () => {
    fakeEngine.method('store.paymentAmount').mockResolvedValue({ amount: 0.6333, display: '0.63330000 DASH', uri: `${PAY}?amount=0.63330000` });
    renderCheckout();
    await act(async () => {});
    await fillAddress();
    await act(async () => {
      fireEvent.press(screen.getByTestId('checkout-to-payment'));
    });
    expect(fakeEngine.method('store.paymentAmount')).toHaveBeenCalledWith({ paymentUri: PAY, total: 1900, currency: 'USD' });
    expect(screen.getByTestId('checkout-coin-amount').props.children).toEqual(['Send ', '0.63330000 DASH']);
    expect(screen.getByTestId('qr-value').props.children).toBe(`${PAY}?amount=0.63330000`);
  });

  it('falls back to the plain address when no price can be read', async () => {
    fakeEngine.method('store.paymentAmount').mockResolvedValue(null);
    renderCheckout();
    await act(async () => {});
    await fillAddress();
    await act(async () => {
      fireEvent.press(screen.getByTestId('checkout-to-payment'));
    });
    expect(screen.queryByTestId('checkout-coin-amount')).toBeNull();
    expect(screen.getByTestId('qr-value').props.children).toBe(PAY);
  });
});

describe('payment amount reads', () => {
  it('never name the payment address or the total in diagnostic labels', () => {
    const label = describeQueryKey(queryKeys.store.paymentAmount(PAY, 1900, 'USD'));
    expect(label).not.toContain('dash:');
    expect(label).not.toContain('1900');
    expect(label).toContain('paymentAmount');
  });
});

describe('store forms (D-950)', () => {
  it('scroll the focused field above the keyboard and let a tap land while it is up', () => {
    render(
      <FormScroll testID="form">
        <Text>Field</Text>
      </FormScroll>,
    );
    const scroll = screen.getByTestId('form');
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
  });
});
