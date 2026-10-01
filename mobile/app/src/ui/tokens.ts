import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Platform, useWindowDimensions } from 'react-native';

/**
 * Raw values for the few places that need a color as a JS value (navigator
 * chrome, icon tints) instead of a className. They mirror the web's
 * tailwind.config.js and Tailwind's default palette; tokens.test.ts fails if
 * they drift from the root config.
 */
export const colors = {
  yappr50: '#f0f9ff',
  yappr300: '#7dd3fc',
  yappr400: '#38bdf8',
  yappr500: '#0ea5e9',
  yappr600: '#0284c7',
  yappr700: '#0369a1',
  white: '#ffffff',
  black: '#000000',
  /** Page surface in dark mode (web `<body>`: `dark:bg-neutral-900`). */
  neutral900: '#171717',
  gray50: '#f9fafb',
  gray100: '#f3f4f6',
  gray200: '#e5e7eb',
  gray300: '#d1d5db',
  gray400: '#9ca3af',
  gray500: '#6b7280',
  gray600: '#4b5563',
  gray700: '#374151',
  gray800: '#1f2937',
  gray900: '#111827',
  gray950: '#030712',
  red400: '#f87171',
  red500: '#ef4444',
  red600: '#dc2626',
  green500: '#22c55e',
  green700: '#15803d',
  amber400: '#fbbf24',
  amber500: '#f59e0b',
  amber700: '#b45309',
  purple500: '#a855f7',
  purple600: '#9333ea',
} as const;

/**
 * The semantic color tokens of UX_SPEC §1.2 as JS values, for icon tints and
 * native props (Switch tracks, ActivityIndicator, RefreshControl). Components
 * style views with the matching classes in `tw` instead.
 */
const light = {
  bg: colors.white,
  bgMuted: colors.gray100,
  bgSkeleton: colors.gray200,
  border: colors.gray200,
  borderStrong: colors.gray300,
  textPrimary: colors.gray900,
  textEmphasis: colors.gray900,
  textSecondary: colors.gray500,
  textPlaceholder: colors.gray600,
  textDisabled: colors.gray400,
  textDecorative: colors.gray300,
  textInverse: colors.white,
  link: colors.yappr700,
  /** Spinner, switch-on track, unread dot, focus ring: never under white text. */
  accent: colors.yappr500,
  /** Fills that carry white text or icons (PRD §11.1 OQ-2: darkened in light mode). */
  accentFill: colors.yappr600,
  like: colors.red600,
  repost: colors.green700,
  destructive: colors.red600,
  warning: colors.amber700,
  error: colors.red600,
  private: colors.purple600,
  ripple: 'rgba(0,0,0,0.08)',
};

export type SemanticColors = { [K in keyof typeof light]: string };

const dark: SemanticColors = {
  bg: colors.neutral900,
  bgMuted: colors.gray900,
  bgSkeleton: colors.gray800,
  border: colors.gray800,
  borderStrong: colors.gray700,
  textPrimary: colors.gray100,
  textEmphasis: colors.white,
  textSecondary: colors.gray400,
  textPlaceholder: colors.gray400,
  textDisabled: colors.gray600,
  textDecorative: colors.gray600,
  textInverse: colors.white,
  link: colors.yappr400,
  accent: colors.yappr500,
  accentFill: colors.yappr500,
  like: colors.red500,
  repost: colors.green500,
  destructive: colors.red400,
  warning: colors.amber400,
  error: colors.red400,
  private: colors.purple500,
  ripple: 'rgba(255,255,255,0.08)',
};

export const semanticColors = { light, dark } as const;

/** The semantic palette for the effective scheme. */
export function useColors(): SemanticColors {
  return useIsDark() ? dark : light;
}

/**
 * The same tokens as NativeWind class pairs, so views follow the scheme
 * without a re-render. Literal strings: Tailwind only generates classes it
 * finds in source.
 */
export const tw = {
  bg: 'bg-white dark:bg-neutral-900',
  bgSubtle: 'bg-gray-50 dark:bg-gray-950',
  bgMuted: 'bg-gray-100 dark:bg-gray-900',
  bgSkeleton: 'bg-gray-200 dark:bg-gray-800',
  bgSelected: 'bg-yappr-50 dark:bg-yappr-950/30',
  bgUnread: 'bg-yappr-50/60 dark:bg-yappr-950/30',
  border: 'border-gray-200 dark:border-gray-800',
  borderStrong: 'border-gray-300 dark:border-gray-700',
  accentFill: 'bg-yappr-600 dark:bg-yappr-500',
  errorBg: 'bg-red-50 dark:bg-red-950/30',
  offlineBg: 'bg-amber-50 dark:bg-amber-950',
} as const;

/** Text colors (UX_SPEC §1.2). Pass one as `Text`'s `tone`. */
export const tones = {
  primary: 'text-gray-900 dark:text-gray-100',
  emphasis: 'text-gray-900 dark:text-white',
  secondary: 'text-gray-500 dark:text-gray-400',
  placeholder: 'text-gray-600 dark:text-gray-400',
  disabled: 'text-gray-400 dark:text-gray-600',
  decorative: 'text-gray-300 dark:text-gray-600',
  inverse: 'text-white',
  link: 'text-yappr-700 dark:text-yappr-400',
  like: 'text-red-600 dark:text-red-500',
  repost: 'text-green-700 dark:text-green-500',
  destructive: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-700 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
  private: 'text-purple-600 dark:text-purple-500',
} as const;

export type Tone = keyof typeof tones;

/** The type scale (UX_SPEC §1.6). Sizes scale with Dynamic Type / font scale. */
export const typeScale = {
  caption: 'text-xs',
  captionStrong: 'text-xs font-semibold',
  chip: 'text-[11px] leading-[14px] font-bold uppercase tracking-[0.5px]',
  subhead: 'text-sm',
  subheadStrong: 'text-sm font-semibold',
  button: 'text-[15px] leading-5 font-semibold',
  buttonSm: 'text-[13px] leading-4 font-semibold',
  body: 'text-base',
  bodyStrong: 'text-base font-semibold',
  bodyLarge: 'text-[17px] leading-[26px]',
  headline: 'text-lg font-semibold',
  title: 'text-xl font-bold',
  titleProfile: 'text-xl font-extrabold',
  titleLarge: 'text-2xl font-bold',
} as const;

export type TypeToken = keyof typeof typeScale;

/**
 * SF Mono / Roboto Mono for identity ids and inline code (UX_SPEC §1.6).
 * A style, not `font-mono`: NativeWind's stack has no Android face.
 */
export const monoFont = { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) };

/** Motion tokens (UX_SPEC §1.8), in ms. */
export const motion = {
  fast: 150,
  base: 200,
  slow: 300,
  pulse: 2000,
  /** Reanimated `withSpring` config for the like heart. */
  springLike: { damping: 12, stiffness: 400, mass: 0.6 },
} as const;

/** Extra touch area so a smaller visual still meets 44 pt / 48 dp (UX_SPEC §6.4). */
export function hitSlopFor(visual: number, target = 48) {
  const pad = Math.max(0, Math.ceil((target - visual) / 2));
  return { top: pad, bottom: pad, left: pad, right: pad };
}

/** True when the effective scheme (system, or the Settings override) is dark. */
export function useIsDark(): boolean {
  return useColorScheme().colorScheme === 'dark';
}

/**
 * Accessibility text sizes (iOS AX1+, Android 160%+), where card headers wrap
 * and action-bar counts move into the labels (UX_SPEC §6.1).
 */
export function useLargeText(): boolean {
  return useWindowDimensions().fontScale >= 1.6;
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
