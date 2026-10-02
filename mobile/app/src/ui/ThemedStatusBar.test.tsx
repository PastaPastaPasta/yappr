import { render } from '@testing-library/react-native';
import { StatusBar } from 'expo-status-bar';

import { ThemedStatusBar } from './ThemedStatusBar';

const scheme = { current: 'light' as 'light' | 'dark' };
jest.mock('nativewind', () => ({
  ...jest.requireActual('nativewind'),
  useColorScheme: () => ({ colorScheme: scheme.current, setColorScheme: jest.fn(), toggleColorScheme: jest.fn() }),
}));

describe('ThemedStatusBar', () => {
  it.each([
    ['dark', 'light'],
    ['light', 'dark'],
  ] as const)('on the %s theme draws %s status bar text', (theme, style) => {
    scheme.current = theme;
    const { UNSAFE_getByType } = render(<ThemedStatusBar />);
    expect(UNSAFE_getByType(StatusBar).props.style).toBe(style);
  });
});
