import { render } from '@testing-library/react-native';
import { NavigationBar } from 'expo-navigation-bar';

import { ThemedNavigationBar } from './ThemedNavigationBar';

const scheme = { current: 'light' as 'light' | 'dark' };
jest.mock('nativewind', () => ({
  ...jest.requireActual('nativewind'),
  useColorScheme: () => ({ colorScheme: scheme.current, setColorScheme: jest.fn(), toggleColorScheme: jest.fn() }),
}));

describe('ThemedNavigationBar', () => {
  it.each([
    ['dark', 'light'],
    ['light', 'dark'],
  ] as const)('on the %s theme draws %s navigation bar buttons', (theme, style) => {
    scheme.current = theme;
    const { UNSAFE_getByType } = render(<ThemedNavigationBar />);
    expect(UNSAFE_getByType(NavigationBar).props.style).toBe(style);
  });

  it('follows a theme change (the Appearance override included)', () => {
    scheme.current = 'light';
    const view = render(<ThemedNavigationBar />);
    scheme.current = 'dark';
    view.rerender(<ThemedNavigationBar />);
    expect(view.UNSAFE_getByType(NavigationBar).props.style).toBe('light');
  });
});
