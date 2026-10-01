import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { useColorScheme } from 'nativewind';

/**
 * Raw values for the few places that need a color as a JS value (navigator
 * chrome, icon tints) instead of a className. They mirror the web's
 * tailwind.config.js and Tailwind's default palette; tokens.test.ts fails if
 * they drift from the root config.
 */
export const colors = {
  yappr500: '#0ea5e9',
  white: '#ffffff',
  black: '#000000',
  /** Page surface in dark mode (web `<body>`: `dark:bg-neutral-900`). */
  neutral900: '#171717',
  gray200: '#e5e7eb',
  gray500: '#6b7280',
  gray800: '#1f2937',
  gray900: '#111827',
} as const;

/** True when the effective scheme (system, or the Settings override) is dark. */
export function useIsDark(): boolean {
  return useColorScheme().colorScheme === 'dark';
}

/** Navigator theme matching the web surfaces (`bg-white dark:bg-neutral-900`, gray borders). */
export function navigationTheme(dark: boolean): Theme {
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.yappr500,
      background: dark ? colors.neutral900 : colors.white,
      card: dark ? colors.neutral900 : colors.white,
      text: dark ? colors.white : colors.gray900,
      border: dark ? colors.gray800 : colors.gray200,
    },
  };
}
