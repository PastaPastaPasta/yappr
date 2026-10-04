import { act, render, screen } from '@testing-library/react-native';
import { Dimensions, Platform } from 'react-native';

import { Text } from './Text';

/** Dimensions as React Native reports them, at `fontScale`. */
function setFontScale(fontScale: number) {
  const window = { ...Dimensions.get('window'), fontScale };
  act(() => Dimensions.set({ window, screen: { ...Dimensions.get('screen'), fontScale } }));
}

describe('Text and the system font scale (D-rc5a-001)', () => {
  const os = Platform.OS;
  const initial = Dimensions.get('window').fontScale;
  const larger = initial + 1;
  afterEach(() => {
    setFontScale(initial);
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  });

  it('mounts anew on Android when the font scale changes, so its box is measured at the new size', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    render(<Text testID="label">Following</Text>);
    const before = screen.getByTestId('label');

    // A window resize that keeps the scale (rotation) keeps the mounted text.
    act(() => Dimensions.set({ window: { ...Dimensions.get('window'), width: 800 }, screen: Dimensions.get('screen') }));
    expect(screen.getByTestId('label')).toBe(before);

    setFontScale(larger);
    const after = screen.getByTestId('label');
    expect(after).not.toBe(before);
    expect(after).toHaveTextContent('Following');
  });

  it('leaves iOS text mounted: iOS re-lays out text for Dynamic Type itself', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    render(<Text testID="label">Following</Text>);
    const before = screen.getByTestId('label');
    setFontScale(larger);
    expect(screen.getByTestId('label')).toBe(before);
  });
});
