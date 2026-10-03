import NetInfo from '@react-native-community/netinfo';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import { fakeEngine } from '~/data/testing/fake-engine';
import { engineSupervisor } from '~/engine';

import { ENGINE_BANNER_COPY, EngineBanner } from './EngineBanner';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
});

describe('EngineBanner', () => {
  it('shows nothing while the engine boots, runs or restarts', () => {
    for (const state of ['handshaking', 'booting', 'ready', 'restarting']) {
      fakeEngine.setStatus({ state });
      const { unmount } = render(<EngineBanner />);
      expect(screen.queryByTestId('engine-banner')).toBeNull();
      unmount();
    }
  });

  it('says "Couldn\'t connect" with Try again once the supervisor gives up (SR-28)', () => {
    fakeEngine.setStatus({ state: 'failed' });
    render(<EngineBanner />);
    expect(screen.getByText(ENGINE_BANNER_COPY.couldntConnect)).toBeTruthy();
    fireEvent.press(screen.getByText('Try again'));
    expect(engineSupervisor.restart).toHaveBeenCalledTimes(1);

    act(() => fakeEngine.setStatus({ state: 'starting' }));
    expect(screen.queryByTestId('engine-banner')).toBeNull();
  });

  it('says "Couldn\'t connect" with Try again when the boot failed while online (NET-01)', () => {
    fakeEngine.setStatus({ state: 'degraded' });
    render(<EngineBanner />);
    expect(screen.getByText(ENGINE_BANNER_COPY.couldntConnect)).toBeTruthy();
    fireEvent.press(screen.getByText('Try again'));
    expect(engineSupervisor.retryBootNow).toHaveBeenCalledTimes(1);
    expect(engineSupervisor.restart).not.toHaveBeenCalled();

    act(() => fakeEngine.setStatus({ state: 'ready' }));
    expect(screen.queryByTestId('engine-banner')).toBeNull();
  });

  it('leaves a boot that failed offline to the offline banner (G-1)', () => {
    jest.mocked(NetInfo.useNetInfo).mockReturnValueOnce({ isConnected: false } as ReturnType<typeof NetInfo.useNetInfo>);
    fakeEngine.setStatus({ state: 'degraded' });
    render(<EngineBanner />);
    expect(screen.queryByTestId('engine-banner')).toBeNull();
  });

  it('keeps the Lockdown banner up while browsing saved posts, with Fix back to its screen (SR-36)', () => {
    fakeEngine.setStatus({ state: 'unsupported', unsupported: 'lockdown' });
    render(<EngineBanner />);
    expect(screen.getByText(ENGINE_BANNER_COPY.lockdown)).toBeTruthy();
    fireEvent.press(screen.getByText('Fix'));
    expect(router.push).toHaveBeenCalledWith('/lockdown');
  });

  it('sends an outdated Android WebView back to its update screen', () => {
    fakeEngine.setStatus({ state: 'unsupported', unsupported: 'webview-outdated' });
    render(<EngineBanner />);
    fireEvent.press(screen.getByText('Fix'));
    expect(router.push).toHaveBeenCalledWith('/webview-update');
  });
});
