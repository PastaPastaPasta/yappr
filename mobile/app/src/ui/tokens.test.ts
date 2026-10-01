import { colors } from './tokens';

interface WebTailwindConfig {
  darkMode: string;
  theme: { extend: { colors: { yappr: Record<string, string> } } };
}

// The web config is the token source of truth.
const webConfig = jest.requireActual<WebTailwindConfig>('../../../../tailwind.config.js');

describe('tokens', () => {
  it('mirrors the web brand color', () => {
    expect(colors.yappr500).toBe(webConfig.theme.extend.colors.yappr[500]);
  });

  it('keeps darkMode class so Settings can override the system scheme', () => {
    expect(webConfig.darkMode).toBe('class');
  });
});
