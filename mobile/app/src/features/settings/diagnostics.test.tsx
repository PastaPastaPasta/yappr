import type { CapabilitiesDTO, EngineDiagnostics, EngineInfo } from '@engine/api';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import type { ReactElement, ReactNode } from 'react';
import { Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { fakeEngine } from '~/data/testing/fake-engine';
import { getEngineErrors, recordEngineError } from '~/engine/errors';
import type { EngineStatus } from '~/engine/supervisor';
import { queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';

import { capabilityRows, diagnosticsText, formatAgo, formatBytes } from './diagnostics';
import { DiagnosticsScreen } from './DiagnosticsScreen';

jest.mock('~/engine', () => {
  const fake = jest.requireActual('~/data/testing/fake-engine').engineModule;
  return {
    ...fake,
    engineStorage: { stats: () => ({ localKeys: 3, secureKeys: 1, identities: 1, snapshotChars: 2048 }) },
    resetEngineData: jest.fn(),
    simulateOnNextBoot: jest.fn(),
  };
});
const mockHeader: { right?: () => ReactNode } = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  Stack: {
    Screen: ({ options }: { options?: { headerRight?: () => ReactNode } }) => {
      mockHeader.right = options?.headerRight;
      return null;
    },
  },
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
const CONTRACTS = {
  social: 'AyWK6nDVfb8d1ZmkM5MmZZrThbUyWyso1aMeGuuVSfxf',
  profile: 'FZSnZdKsLAuWxE7iZJq12eEz6xSKTCqVSqxVF5c4iTdN',
  dpns: 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec',
  dm: '7HxR1G5r1yEa8vEakNpXfY6iVnmLz5ezZMCXGAZ93rpi',
  dmV5: '3P1NJYVnzaR1LTwCQnU8VMb4Ybz5VuYFHjCbLV13PfRu',
  pollr: 'GBCR8JqtXNMZa4B16ZAYm3RkNHrPcU3D36jcAoYWvr8E',
};
const INFO = {
  network: 'devnet',
  topology: 'v10',
  evoSdkVersion: '5.0.0-beta.1',
  variant: 'devnet',
  webAssembly: true,
  bootMs: 3412,
  contracts: CONTRACTS,
  capabilities: { rankings: true, repostable: { post: true, reply: false }, dm: 'v5' } as unknown as CapabilitiesDTO,
} as Partial<EngineInfo>;

const diagnostics = (lastOkAgoMs: number): EngineDiagnostics => ({
  wasmMs: 2180,
  dapi: {
    configured: 13,
    lastOkAt: Date.now() - lastOkAgoMs,
    endpoints: [
      { origin: 'https://10.0.0.1:1443', requests: 20, failures: 1, lastOkAt: Date.now() - lastOkAgoMs, lastErrorAt: null },
    ],
  },
});

function renderScreen(element: ReactElement) {
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}

const settle = () => act(async () => {});

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  fakeEngine.setStatus({ state: 'ready', epoch: 1, info: INFO });
  fakeEngine.method('engine.diagnostics').mockResolvedValue(diagnostics(4000));
  fakeEngine.method('session.current').mockResolvedValue(null);
});

describe('diagnostics helpers', () => {
  it('formats sizes and ages', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(18.2 * 1024 * 1024)).toBe('18.2 MB');
    expect(formatAgo(null, 0)).toBe('never');
    expect(formatAgo(1000, 5000)).toBe('4s ago');
    expect(formatAgo(0, 125_000)).toBe('2m ago');
  });

  it('flattens the capability flags', () => {
    expect(capabilityRows(INFO.capabilities)).toEqual([
      { label: 'rankings', value: 'Yes' },
      { label: 'repostable.post', value: 'Yes' },
      { label: 'repostable.reply', value: 'No' },
      { label: 'dm', value: 'v5' },
    ]);
  });

  it('the shared text has every SET-08 field, and no secrets', () => {
    recordEngineError('profiles.get', `signing with ${WIF} failed`);
    const text = diagnosticsText({
      status: { state: 'ready', epoch: 1, restarts: 0, queued: 0, reason: null, unsupported: null, hello: null, caps: null, timings: null, info: INFO as EngineInfo } as EngineStatus,
      diagnostics: diagnostics(4000),
      cacheBytes: 2048,
      errors: getEngineErrors(),
      logs: [],
      networkKey: 'devnet-sakura',
      now: Date.now(),
    });
    expect(text).toContain('wasm compile: 2180 ms');
    expect(text).toContain('boot: 3412 ms');
    expect(text).toMatch(/dapi: 13 endpoints \(13 configured\), last ok \ds ago/);
    expect(text).toContain(`pollr ${CONTRACTS.pollr}`);
    expect(text).toContain('repostable.reply=No');
    expect(text).toContain('cache: 2.0 KB');
    expect(text).toContain('profiles.get signing with');
    expect(text).not.toContain(WIF);
  });
});

describe('Engine diagnostics (SET-08)', () => {
  it('shows WASM compile, DAPI endpoints, capabilities, every contract with copy, the cache and recent errors', async () => {
    syncStorage.setItem('yappr-query-cache', 'x'.repeat(3072));
    recordEngineError('feed.home', 'Dash Platform is temporarily unavailable');
    renderScreen(<DiagnosticsScreen />);
    await settle();

    expect(screen.getByText('WASM compile')).toBeTruthy();
    expect(screen.getByText('2,180 ms')).toBeTruthy();
    expect(screen.getByText('3,412 ms')).toBeTruthy();
    expect(screen.getByText(/^13 · last ok \ds ago$/)).toBeTruthy();
    fireEvent.press(screen.getByTestId('diagnostics-dapi'));
    expect(screen.getByText('10.0.0.1:1443')).toBeTruthy();
    fireEvent.press(screen.getByTestId('diagnostics-capabilities'));
    expect(screen.getByText('repostable.reply')).toBeTruthy();
    expect(screen.getByText('3.0 KB')).toBeTruthy();

    expect(screen.getByText('Pollr contract')).toBeTruthy();
    fireEvent.press(screen.getByTestId('diagnostics-copy-pollr'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(CONTRACTS.pollr);

    expect(screen.getByText(/^Recent errors \(\d+\)$/)).toBeTruthy();
    expect(screen.getByText('Dash Platform is temporarily unavailable')).toBeTruthy();
    // A read that fails while the screen is open lands in the list.
    act(() => recordEngineError('posts.thread', 'Engine call posts.thread timed out after 30000 ms'));
    expect(screen.getByText('Engine call posts.thread timed out after 30000 ms')).toBeTruthy();
  });

  it('stops asking an engine that predates engine.diagnostics, instead of logging an error every 2 s', async () => {
    jest.useFakeTimers();
    try {
      fakeEngine
        .method('engine.diagnostics')
        .mockRejectedValue(Object.assign(new Error('Unknown engine method: engine.diagnostics'), { code: 'UNKNOWN_METHOD' }));
      renderScreen(<DiagnosticsScreen />);
      await settle();
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(fakeEngine.method('engine.diagnostics')).toHaveBeenCalledTimes(1);
      expect(screen.getByText('WASM compile')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shares the redacted text natively, from the header and the button', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderScreen(<DiagnosticsScreen />);
    await settle();

    fireEvent.press(screen.getByTestId('diagnostics-share'));
    expect(share).toHaveBeenCalledWith({ message: expect.stringContaining(`pollr ${CONTRACTS.pollr}`) });
    expect(share.mock.calls[0][0].message).toContain('wasm compile: 2180 ms');

    const header = renderScreen(<>{mockHeader.right?.()}</>);
    fireEvent.press(header.getByTestId('diagnostics-share-header'));
    expect(share).toHaveBeenCalledTimes(2);
  });
});
