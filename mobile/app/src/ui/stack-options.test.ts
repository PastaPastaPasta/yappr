import type { Platform as PlatformType } from 'react-native';

import type * as StackOptions from './stack-options';

/** stack-options as it loads on `os` (it reads the platform once, at import). */
function load(os: typeof PlatformType.OS): typeof StackOptions {
  let mod: typeof StackOptions | undefined;
  jest.isolateModules(() => {
    const { Platform } = jest.requireActual<typeof import('react-native')>('react-native');
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    mod = jest.requireActual<typeof StackOptions>('./stack-options');
  });
  if (!mod) throw new Error('stack-options did not load');
  return mod;
}

describe('stackScreenOptions', () => {
  // D-L4a-005: the toolbar's default title is 20 dp, so it stayed put at 200 % font scale.
  // An explicit size goes to react-native-screens as sp, which follows the font scale.
  it('gives the Android title an explicit size, so it scales with the font (A11Y-01)', () => {
    const { stackScreenOptions, ANDROID_HEADER_TITLE_SIZE } = load('android');

    expect(stackScreenOptions.headerTitleStyle).toEqual({ fontSize: ANDROID_HEADER_TITLE_SIZE });
    expect(ANDROID_HEADER_TITLE_SIZE).toBe(20);
  });

  it('leaves the iOS navigation bar fonts to UIKit', () => {
    const { stackScreenOptions } = load('ios');

    expect(stackScreenOptions.headerTitleStyle).toBeUndefined();
    expect(stackScreenOptions.headerBackButtonDisplayMode).toBe('minimal');
  });
});
