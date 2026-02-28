import type { EmbedTheme } from '../types';

export interface ResolvedTheme {
  mode: 'light' | 'dark';
  variables: Record<string, string>;
}

const LIGHT_THEME: Record<string, string> = {
  '--yappr-bg': '#ffffff',
  '--yappr-text': '#121621',
  '--yappr-muted': '#5f6675',
  '--yappr-border': '#d8dde7',
  '--yappr-surface': '#f7f9fc',
  '--yappr-link': '#0f5fd7',
  '--yappr-code-bg': '#edf2fa'
};

const DARK_THEME: Record<string, string> = {
  '--yappr-bg': '#111827',
  '--yappr-text': '#f8fafc',
  '--yappr-muted': '#9ca3af',
  '--yappr-border': '#293245',
  '--yappr-surface': '#1a2436',
  '--yappr-link': '#93c5fd',
  '--yappr-code-bg': '#0f172a'
};

function parseThemeConfig(themeConfig?: string): Record<string, string> {
  if (!themeConfig) {
    return {};
  }

  try {
    const parsed = JSON.parse(themeConfig) as Record<string, unknown>;
    const variables: Record<string, string> = {};

    Object.entries(parsed).forEach(([key, value]) => {
      if (typeof value === 'string') {
        if (key.startsWith('--')) {
          variables[key] = value;
        } else {
          variables[`--yappr-${key}`] = value;
        }
      }
    });

    return variables;
  } catch {
    return {};
  }
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'light';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(theme: EmbedTheme = 'auto', themeConfig?: string): ResolvedTheme {
  const mode = theme === 'auto' ? getSystemTheme() : theme;
  const base = mode === 'dark' ? DARK_THEME : LIGHT_THEME;
  const overrides = parseThemeConfig(themeConfig);

  return {
    mode,
    variables: {
      ...base,
      ...overrides
    }
  };
}

export function applyThemeVariables(element: HTMLElement, variables: Record<string, string>): void {
  Object.entries(variables).forEach(([key, value]) => {
    element.style.setProperty(key, value);
  });
}
