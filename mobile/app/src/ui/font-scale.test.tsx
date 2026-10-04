import { act, render, screen } from '@testing-library/react-native';
import { Dimensions, Platform } from 'react-native';

import { remeasureProps } from './font-scale';
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
  const setOS = (value: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { value, configurable: true });
  afterEach(() => {
    setFontScale(initial);
    setOS(os);
  });

  it('mounts anew on Android when the font scale changes, under a new text-size cache key, so it is measured at the new size', () => {
    setOS('android');
    render(<Text testID="label">Following</Text>);
    const before = screen.getByTestId('label');
    const keyBefore: unknown = before.props.dynamicTypeRamp;

    // A window resize that keeps the scale (rotation) keeps the mounted text.
    act(() => Dimensions.set({ window: { ...Dimensions.get('window'), width: 800 }, screen: Dimensions.get('screen') }));
    expect(screen.getByTestId('label')).toBe(before);

    setFontScale(larger);
    const after = screen.getByTestId('label');
    expect(after).not.toBe(before);
    expect(after).toHaveTextContent('Following');
    // Same text, same width: without a new key the size cached during the change would come back.
    const keyAfter: unknown = after.props.dynamicTypeRamp;
    expect(keyAfter).toBeDefined();
    expect(keyAfter).not.toBe(keyBefore);

    // And back: a key of its own again.
    setFontScale(initial);
    const back = screen.getByTestId('label');
    expect(back).not.toBe(after);
    expect(back.props.dynamicTypeRamp).not.toBe(keyAfter);
  });

  it('leaves iOS text mounted, and its Dynamic Type ramp alone: iOS re-lays out text for Dynamic Type itself', () => {
    setOS('ios');
    render(<Text testID="label">Following</Text>);
    const before = screen.getByTestId('label');
    setFontScale(larger);
    expect(screen.getByTestId('label')).toBe(before);
    expect(before.props.dynamicTypeRamp).toBeUndefined();
  });

  it('gives each of 11 changes in a row its own key, and none before the first or on iOS', () => {
    setOS('android');
    expect(remeasureProps(0)).toEqual({});
    const keys = Array.from({ length: 11 }, (_, i) => remeasureProps(i + 1).dynamicTypeRamp);
    expect(new Set(keys).size).toBe(11);
    expect(keys).not.toContain(undefined);
    setOS('ios');
    expect(remeasureProps(3)).toEqual({});
  });
});
