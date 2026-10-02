import { act, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAppLockSettings, useLockState } from './app-lock';
import { AppLockOverlay } from './AppLockOverlay';

const native = jest.requireMock<{ isCaptureBlocked: () => boolean }>('../../../modules/secure-window');
const realOS = Platform.OS;
const setOS = (os: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const renderOverlay = () =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppLockOverlay />
    </SafeAreaProvider>,
  );

beforeEach(() => {
  useLockState.setState({ locked: false, covered: false, authenticating: false, backgroundAt: null });
});
afterEach(() => {
  setOS(realOS);
  useAppLockSettings.setState({ enabled: false });
});

describe('app-switcher privacy (AUTH-12)', () => {
  it('on Android, keeps the whole app FLAG_SECURE while the lock is on', () => {
    setOS('android');
    useAppLockSettings.setState({ enabled: true });
    const view = renderOverlay();
    expect(native.isCaptureBlocked()).toBe(true);

    act(() => useAppLockSettings.setState({ enabled: false }));
    expect(native.isCaptureBlocked()).toBe(false);
    view.unmount();
  });

  it('on Android, leaves capture alone while the lock is off', () => {
    setOS('android');
    renderOverlay().unmount();
    expect(native.isCaptureBlocked()).toBe(false);
  });

  it('on iOS, relies on the lock screen cover instead of blocking screenshots', () => {
    setOS('ios');
    useAppLockSettings.setState({ enabled: true });
    const view = renderOverlay();
    expect(native.isCaptureBlocked()).toBe(false);

    act(() => useLockState.setState({ covered: true }));
    expect(view.getByTestId('app-lock')).toBeTruthy();
    view.unmount();
  });
});
