import { act, render } from '@testing-library/react-native';
import { StatusBar, setStatusBarStyle } from 'expo-status-bar';

import { ThemedStatusBar } from './ThemedStatusBar';

const scheme = { current: 'light' as 'light' | 'dark' };
jest.mock('nativewind', () => ({
  ...jest.requireActual('nativewind'),
  useColorScheme: () => ({ colorScheme: scheme.current, setColorScheme: jest.fn(), toggleColorScheme: jest.fn() }),
}));
jest.mock('expo-status-bar', () => ({
  ...jest.requireActual('expo-status-bar'),
  setStatusBarStyle: jest.fn(),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(setStatusBarStyle).mockClear();
});
afterEach(() => jest.useRealTimers());

describe('ThemedStatusBar', () => {
  it.each([
    ['dark', 'light'],
    ['light', 'dark'],
  ] as const)('on the %s theme draws %s status bar text, and sets it again once the change settles', (theme, style) => {
    scheme.current = theme;
    const { UNSAFE_getByType } = render(<ThemedStatusBar />);
    expect(UNSAFE_getByType(StatusBar).props.style).toBe(style);
    act(() => jest.advanceTimersByTime(2000));
    expect(jest.mocked(setStatusBarStyle).mock.calls).toEqual([[style, false], [style, false]]);
  });

  it('follows a theme change', () => {
    scheme.current = 'light';
    const view = render(<ThemedStatusBar />);
    scheme.current = 'dark';
    view.rerender(<ThemedStatusBar />);
    act(() => jest.advanceTimersByTime(2000));
    expect(view.UNSAFE_getByType(StatusBar).props.style).toBe('light');
    // The light theme's pending re-sets were cancelled by the change.
    expect(jest.mocked(setStatusBarStyle).mock.calls).toEqual([['light', false], ['light', false]]);
  });
});
