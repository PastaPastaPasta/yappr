import { act, renderRouter, screen } from 'expo-router/testing-library';
import { Dimensions, Platform, StyleSheet } from 'react-native';

import { useOnboarding } from '~/features/auth/onboarding';
import { tabBadgeStyle } from '~/ui/Badge';

jest.mock('~/state/tab-badges', () => ({ useTabBadges: () => ({ notifications: 3, messages: 120 }) }));

const os = Platform.OS;
const window = Dimensions.get('window');
const setOS = (value: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { value, configurable: true });
const setFontScale = (fontScale: number) =>
  Dimensions.set({ window: { ...window, fontScale }, screen: { ...Dimensions.get('screen'), fontScale } });

async function renderTabs() {
  renderRouter('./src/app', { initialUrl: '/' });
  await act(async () => {});
}

beforeEach(() => useOnboarding.setState({ welcomed: true }));
afterEach(() => {
  setOS(os);
  setFontScale(window.fontScale);
});

describe('tab bar badges (NOTIF-03, DM-13)', () => {
  it('caps the badge at 1.5× and keeps its box and number in step', () => {
    expect(tabBadgeStyle(1)).toMatchObject({ height: 20, minWidth: 20, fontSize: 12, lineHeight: 19 });
    expect(tabBadgeStyle(2)).toMatchObject({ height: 30, minWidth: 30, fontSize: 18, lineHeight: 29 });
    expect(tabBadgeStyle(0.85)).toEqual(tabBadgeStyle(1));
  });

  // D-L4a-008: at 200 % the number grew past its fixed 18 pt circle and was cut off.
  it('on Android at 200 %, sizes the badge itself instead of letting the system scale its number', async () => {
    setOS('android');
    setFontScale(2);
    await renderTabs();

    for (const label of ['3', '99+']) {
      const badge = screen.getByText(label);
      expect(badge.props.allowFontScaling).toBe(false);
      expect(StyleSheet.flatten(badge.props.style)).toMatchObject(tabBadgeStyle(2));
    }
  });
});
