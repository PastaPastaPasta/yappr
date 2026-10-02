import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { blocksCapture, useBlockScreenCapture, type CaptureScope } from './screen-capture';

const { __blocked: blocked } = jest.requireMock<{ __blocked: Set<string> }>('expo-screen-capture');
const realOS = Platform.OS;
const setOS = (os: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

afterEach(() => {
  setOS(realOS);
  blocked.clear();
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
  const hook = (scope: CaptureScope, active?: boolean) =>
    renderHook(({ on }: { on?: boolean }) => useBlockScreenCapture(scope, on), { initialProps: { on: active } });

  it('holds a block while active and releases it on unmount', () => {
    setOS('android');
    const view = hook('private');
    expect(blocked.size).toBe(1);
    view.unmount();
    expect(blocked.size).toBe(0);
  });

  it('follows `active` (a screen losing focus releases its block)', () => {
    setOS('android');
    const view = hook('private', false);
    expect(blocked.size).toBe(0);
    view.rerender({ on: true });
    expect(blocked.size).toBe(1);
    view.rerender({ on: false });
    expect(blocked.size).toBe(0);
  });

  it('does not block private content on iOS, where the lock screen covers the snapshot', () => {
    setOS('ios');
    hook('private');
    expect(blocked.size).toBe(0);
    hook('secret');
    expect(blocked.size).toBe(1);
  });

  it('keys each holder separately, so one leaving keeps the other blocked', () => {
    setOS('android');
    const lock = hook('private');
    const keyScreen = hook('secret');
    expect(blocked.size).toBe(2);
    keyScreen.unmount();
    expect(blocked.size).toBe(1);
    lock.unmount();
    expect(blocked.size).toBe(0);
  });
});
