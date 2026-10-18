import { readFileSync } from 'node:fs';
import { cssToReactNativeRuntime } from 'react-native-css-interop/css-to-rn';
import { renderHook } from '@testing-library/react-native';

import { colors, useColors } from './tokens';

const mockScheme = { current: 'light' as 'light' | 'dark' };
jest.mock('nativewind', () => ({
  ...jest.requireActual('nativewind'),
  useColorScheme: () => ({ colorScheme: mockScheme.current }),
}));

interface WebTailwindConfig {
  darkMode: string;
  theme: { extend: { colors: { yappr: Record<string, string> } } };
}

// The web config is the token source of truth.
const webConfig = jest.requireActual<WebTailwindConfig>('../../../../tailwind.config.js');

describe('tokens', () => {
  it('mirrors the web brand fills', () => {
    expect(colors.yappr500).toBe(webConfig.theme.extend.colors.yappr[500]);
    expect(colors.yappr600).toBe(webConfig.theme.extend.colors.yappr[600]);
  });

  it('keeps darkMode class so Settings can override the system scheme', () => {
    expect(webConfig.darkMode).toBe('class');
  });
});

const textVariables = ['--accent-text', '--accent-text-hover', '--text-muted', '--text-secondary'];
const mobileCss = readFileSync(`${__dirname}/../global.css`, 'utf8');
const webCss = readFileSync(`${__dirname}/../../../../app/globals.css`, 'utf8');
const probes = textVariables.map((name, i) => `.probe-${i}{color:rgb(var(${name}))}`).join('\n');
const nativeVariables = cssToReactNativeRuntime(mobileCss + probes).rootVariables;

function hex(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('Expected an RGB text token');
  return '#' + value.map((channel: number) => channel.toString(16).padStart(2, '0')).join('');
}

describe('shared theme text utilities on native', () => {
  it.each(textVariables)('%s compiles to both web theme values', (name) => {
    const values = [...webCss.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))]
      .map((match) => match[1].trim().split(/\s+/).map(Number));
    expect(values).toHaveLength(2);
    expect(nativeVariables?.[name]).toEqual({ light: values[0], dark: values[1] });
  });

  it.each(['light', 'dark'] as const)('native props and shared text classes agree in %s mode', (theme) => {
    mockScheme.current = theme;
    const { result } = renderHook(() => useColors());
    const variable = theme === 'light' ? '--text-secondary' : '--text-muted';
    expect(result.current.textSecondary).toBe(hex(nativeVariables?.[variable]?.[theme]));
    expect(result.current.link).toBe(hex(nativeVariables?.['--accent-text']?.[theme]));
    if (theme === 'dark') expect(result.current.accent).toBe(result.current.link);
  });
});
