import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { getLogs } from '~/engine/logs';

import { blocksCapture, useBlockScreenCapture, type CaptureScope } from './screen-capture';

const native = jest.requireMock<{ setCaptureBlocked: jest.Mock; isCaptureBlocked: () => boolean }>(
  '../../modules/secure-window',
);
const realOS = Platform.OS;
const setOS = (os: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
const mounted: { unmount: () => void }[] = [];
const hook = (scope: CaptureScope, active?: boolean) => {
  const view = renderHook(({ on }: { on?: boolean }) => useBlockScreenCapture(scope, on), {
    initialProps: { on: active },
  });
  mounted.push(view);
  return view;
};

beforeEach(() => native.setCaptureBlocked.mockClear());
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount());
  setOS(realOS);
});

describe('blocksCapture', () => {
  it('blocks secrets everywhere, and private content only on Android', () => {
    expect(blocksCapture('secret', 'ios')).toBe(true);
    expect(blocksCapture('secret', 'android')).toBe(true);
    expect(blocksCapture('private', 'android')).toBe(true);
    expect(blocksCapture('private', 'ios')).toBe(false);
    expect(blocksCapture('secret', 'web')).toBe(false);
  });
});

describe('useBlockScreenCapture', () => {
  it('holds a block while mounted and releases it on unmount', () => {
    setOS('android');
    const view = hook('private');
    expect(native.isCaptureBlocked()).toBe(true);
    view.unmount();
    expect(native.isCaptureBlocked()).toBe(false);
  });

  it('follows `active` (a screen losing focus releases its block)', () => {
    setOS('android');
    const view = hook('private', false);
    expect(native.isCaptureBlocked()).toBe(false);
    view.rerender({ on: true });
    expect(native.isCaptureBlocked()).toBe(true);
    view.rerender({ on: false });
    expect(native.isCaptureBlocked()).toBe(false);
  });

  it('does not block private content on iOS, where the lock screen covers the snapshot', () => {
    setOS('ios');
    hook('private');
    expect(native.setCaptureBlocked).not.toHaveBeenCalled();
    hook('secret');
    expect(native.isCaptureBlocked()).toBe(true);
  });

  it('tells native only on the first hold and the last release', () => {
    setOS('ios');
    const sheet = hook('secret');
    const keyScreen = hook('secret');
    expect(native.setCaptureBlocked.mock.calls).toEqual([[true]]);

    sheet.unmount();
    expect(native.isCaptureBlocked()).toBe(true);
    keyScreen.unmount();
    expect(native.setCaptureBlocked.mock.calls).toEqual([[true], [false]]);
  });

  it('logs instead of throwing when native refuses', async () => {
    setOS('android');
    native.setCaptureBlocked.mockRejectedValueOnce(new Error('no activity'));
    hook('private');
    await act(async () => {});
    expect(getLogs().some((line) => line.message.includes('Blocking screen capture failed: no activity'))).toBe(true);
  });
});
